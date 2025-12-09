use anchor_lang::prelude::*;
use switchboard_on_demand::{RandomnessAccountData, ON_DEMAND_DEVNET_PID};

declare_id!("XAcs9KPMLSbtTaD6PEcVHwkcrgfGDY5D3ZroRBwhiFX");
#[program]
pub mod random_number {
    use super::*;

    // 1. NEW: Initialize the game accounts
    pub fn initialize(ctx: Context<Initialize>, min: u64, max: u64) -> Result<()> {
        let range = &mut ctx.accounts.range;
        range.from = min;
        range.to = max;

        // Initialize result to 0
        ctx.accounts.game_state.result = 0;
        msg!("Game Initialized: Range {}-{}", min, max);
        Ok(())
    }

    // 2. YOUR ORIGINAL LOGIC (Unchanged)
    pub fn random_number(ctx: Context<ConsumeRandomness>) -> Result<()> {
        let randomness_account = &ctx.accounts.randomness_account;
        let range = &ctx.accounts.range;
        let game_state = &mut ctx.accounts.game_state;
        let clock = Clock::get()?;

        let randomness_data = RandomnessAccountData::parse(randomness_account.data.borrow())
            .map_err(|_| error!(GameError::InvalidSwitchboardAccount))?;

        // Check if randomness is revealed for the current slot
        let random_value = randomness_data
            .get_value(clock.slot)
            .map_err(|_| error!(GameError::RandomnessNotResolved))?;

        let random_int = u64::from_le_bytes(random_value[0..8].try_into().unwrap());

        // Calculate winner
        let result = (random_int % (range.to - range.from + 1)) + range.from;
        game_state.result = result;

        msg!("The winning number is: {:?}", result);

        Ok(())
    }
}
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 8 + 8)] // Discriminator + u64 + u64
    pub range: Account<'info, Range>,
    #[account(init, payer = user, space = 8 + 8)] // Discriminator + u64
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConsumeRandomness<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Validated inside the instruction
    #[account(owner = ON_DEMAND_DEVNET_PID)]
    pub randomness_account: AccountInfo<'info>,
    pub range: Account<'info, Range>,
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct GameState {
    pub result: u64,
}

#[account]
pub struct Range {
    pub from: u64,
    pub to: u64,
}

#[error_code]
pub enum GameError {
    #[msg("The provided account is not a valid Switchboard account.")]
    InvalidSwitchboardAccount,
    #[msg("The randomness has not been resolved yet.")]
    RandomnessNotResolved,
}
