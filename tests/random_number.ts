import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { RandomNumber } from "../target/types/random_number";
import {
  Randomness,
  ON_DEMAND_DEVNET_PID,
  ON_DEMAND_DEVNET_QUEUE,
} from "@switchboard-xyz/on-demand";
import {
  Keypair,
  SystemProgram,
  Transaction,
  PublicKey,
} from "@solana/web3.js";
import { assert } from "chai";
import * as sb from "@switchboard-xyz/on-demand";

describe("random_number", () => {
  // Configure the client to use the DEVNET cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RandomNumber as Program<RandomNumber>;

  // Generate keys for our game accounts
  const rangeKp = Keypair.generate();
  const gameStateKp = Keypair.generate();
  const rngKp = Keypair.generate(); // Key for Switchboard Randomness

  let switchboardProgram: Program<Idl>;

  before("load switchboard program", async () => {
    const switchboardIdl = await anchor.Program.fetchIdl(
      ON_DEMAND_DEVNET_PID,
      provider
    );
    switchboardProgram = new anchor.Program(switchboardIdl, provider);

    console.log("🚀 ~ ON_DEMAND_DEVNET_PID:", ON_DEMAND_DEVNET_PID);
    console.log("🚀 ~ ON_DEMAND_DEVNET_QUEUE:", ON_DEMAND_DEVNET_QUEUE);
    console.log("Setup complete. Running tests on Devnet.");
    console.log("Your wallet:", provider.wallet.publicKey.toString());
    console.log("Your program:", program.programId.toString());
    console.log("Randomness key:", rngKp.publicKey.toString());
  });

  // Test Params
  const MIN = new anchor.BN(1);
  const MAX = new anchor.BN(100);

  it("Step 1: Initialize Game Accounts", async () => {
    await program.methods
      .initialize(MIN, MAX)
      .accounts({
        range: rangeKp.publicKey,
        gameState: gameStateKp.publicKey,
        user: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([rangeKp, gameStateKp])
      .rpc();

    console.log("Game Initialized!");

    // Verify on-chain state
    const rangeAccount = await program.account.range.fetch(rangeKp.publicKey);
    assert.ok(rangeAccount.from.eq(MIN));
    assert.ok(rangeAccount.to.eq(MAX));
  });

  it("Step 2: Request & Reveal Randomness", async () => {
    // A. Load Switchboard Devnet Queue
    const queue = ON_DEMAND_DEVNET_QUEUE;
    const queueAccount = new sb.Queue(switchboardProgram as any, queue);

    try {
      await queueAccount.loadData();
    } catch (err) {
      console.log("Queue account not found");
      process.exit(1);
    }

    console.log("Creating Switchboard Randomness...");

    // B. Create Randomness Account & Commit
    // This tells Switchboard: "I want a random number for a future slot"
    const [randomness, ix] = await Randomness.create(
      switchboardProgram as any,
      rngKp,
      queue
    );
    console.log("Randomness created:", randomness.pubkey.toBase58());

    const createRandomnessTx = await sb.asV0Tx({
      connection: provider.connection,
      ixs: [ix],
      payer: provider.wallet.publicKey,
      signers: [provider.wallet.payer, rngKp],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    const blockhashContext =
      await provider.connection.getLatestBlockhashAndContext();

    const createRandomnessSignature = await provider.connection.sendTransaction(
      createRandomnessTx
    );
    await provider.connection.confirmTransaction({
      signature: createRandomnessSignature,
      blockhash: blockhashContext.value.blockhash,
      lastValidBlockHeight: blockhashContext.value.lastValidBlockHeight,
    });
    console.log(
      "Transaction Signature for randomness account creation: ",
      createRandomnessSignature
    );

    console.log("Committing randomness...");
    const commitIx = await randomness.commitIx(queue);
    console.log("🚀 ~ commitIx:", commitIx);

    const createTx = await provider.sendAndConfirm(
      new Transaction().add(commitIx),
      [rngKp]
    );
    console.log(`Randomness Committed: ${createTx}`);

    // C. Wait for Oracle (Simulate waiting for the block)
    console.log("Waiting 15 seconds for Oracle to confirm block...");
    await new Promise((resolve) => setTimeout(resolve, 15000));

    // D. Reveal & Consume
    // We combine the Switchboard "Reveal" instruction with your "random_number" instruction
    // so they happen in the same transaction.
    const revealIx = await randomness.revealIx();

    const consumeIx = await program.methods
      .randomNumber()
      .accounts({
        user: provider.wallet.publicKey,
        randomnessAccount: rngKp.publicKey,
        range: rangeKp.publicKey,
        gameState: gameStateKp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Add priority fees to ensure reliability on Devnet
    const priorityFeeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 100_000,
    });

    console.log("Revealing and consuming...");
    const tx = await provider.sendAndConfirm(
      new Transaction().add(priorityFeeIx).add(revealIx).add(consumeIx),
      []
    );

    console.log(`Success! Transaction: ${tx}`);

    // E. Verify Result
    const gameState = await program.account.gameState.fetch(
      gameStateKp.publicKey
    );
    const result = gameState.result.toNumber();

    console.log(`🎲 Generated Number: ${result}`);

    assert.isAtLeast(result, MIN.toNumber());
    assert.isAtMost(result, MAX.toNumber());
  });
});
