use anchor_lang::prelude::*;

declare_id!("6kvU5Woa1g6hAqRc3MSg7j3PqFC3Xa91285ZqERwi4SB");

#[program]
pub mod miner_vault {
    use super::*;

    /// Creates the vault. The signer becomes the permanent protocol authority.
    /// Positions are mocked as on-chain data — no real Raydium CPI required.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        ceiling_l: u128,
        miner: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.protocol = ctx.accounts.protocol.key();
        vault.miner = miner;
        vault.ceiling = ceiling_l;
        vault.deployed_l = 0;
        vault.next_position_id = 0;
        vault.bump = ctx.bumps.vault_state;
        Ok(())
    }

    /// Protocol: update the deployment ceiling. May be set above or below the
    /// current deployed_l. If set below, no new positions can be opened until
    /// enough existing positions are closed to bring deployed_l back under it.
    pub fn set_ceiling(ctx: Context<ProtocolInstruction>, new_ceiling_l: u128) -> Result<()> {
        ctx.accounts.vault_state.ceiling = new_ceiling_l;
        Ok(())
    }

    /// Protocol: rotate the active miner without touching any funds or
    /// existing positions. All Position PDAs remain open under the new miner.
    pub fn set_miner(ctx: Context<ProtocolInstruction>, new_miner: Pubkey) -> Result<()> {
        ctx.accounts.vault_state.miner = new_miner;
        Ok(())
    }

    /// Protocol emergency override: close any position regardless of state.
    /// Frees the liquidity back to the ceiling budget.
    pub fn force_close_position(
        ctx: Context<ForceClosePosition>,
        _position_id: u64,
    ) -> Result<()> {
        let liquidity = ctx.accounts.position.liquidity;
        ctx.accounts.vault_state.deployed_l = ctx
            .accounts
            .vault_state
            .deployed_l
            .checked_sub(liquidity)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        Ok(())
    }

    /// Miner: open a new liquidity position. The ceiling check is atomic with
    /// the state write — there is no window to race the counter.
    pub fn open_position(
        ctx: Context<OpenPosition>,
        tick_lower: i32,
        tick_upper: i32,
        liquidity: u128,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;

        let new_deployed = vault
            .deployed_l
            .checked_add(liquidity)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        require!(new_deployed <= vault.ceiling, ErrorCode::CeilingExceeded);

        let position_id = vault.next_position_id;

        let position = &mut ctx.accounts.position;
        position.vault = vault.key();
        position.id = position_id;
        position.tick_lower = tick_lower;
        position.tick_upper = tick_upper;
        position.liquidity = liquidity;
        position.bump = ctx.bumps.position;

        vault.deployed_l = new_deployed;
        vault.next_position_id = vault
            .next_position_id
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        Ok(())
    }

    /// Miner: close one of their own positions. Rent is returned to the miner.
    /// Frees liquidity back into the ceiling budget for reuse.
    pub fn close_position(ctx: Context<ClosePosition>, _position_id: u64) -> Result<()> {
        let liquidity = ctx.accounts.position.liquidity;
        ctx.accounts.vault_state.deployed_l = ctx
            .accounts
            .vault_state
            .deployed_l
            .checked_sub(liquidity)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        Ok(())
    }
}

// ── Account data structs ──────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    /// Permanent admin — set once at initialize_vault, never changes.
    pub protocol: Pubkey,
    /// Rotating operator — can be updated by protocol via set_miner.
    pub miner: Pubkey,
    /// Maximum liquidity units the miner may have open at once.
    pub ceiling: u128,
    /// Running total of all currently open position liquidities.
    /// Checked atomically on every open_position; never stale.
    pub deployed_l: u128,
    /// Auto-incrementing counter used as the unique position seed.
    pub next_position_id: u64,
    /// Stored bump for gas-free PDA re-derivation.
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    /// Back-link to the vault this position belongs to.
    /// Prevents cross-vault account substitution attacks.
    pub vault: Pubkey,
    /// Unique ID copied from next_position_id at creation time.
    pub id: u64,
    pub tick_lower: i32,
    pub tick_upper: i32,
    /// Liquidity units deployed in this position.
    pub liquidity: u128,
    pub bump: u8,
}

// ── Instruction contexts ──────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = protocol,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault", protocol.key().as_ref()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub protocol: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Reused by set_ceiling and set_miner — any instruction that only needs
/// the vault and the protocol signer.
#[derive(Accounts)]
pub struct ProtocolInstruction<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.protocol.as_ref()],
        bump = vault_state.bump,
        has_one = protocol @ ErrorCode::WrongAuthority,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub protocol: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct ForceClosePosition<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.protocol.as_ref()],
        bump = vault_state.bump,
        has_one = protocol @ ErrorCode::WrongAuthority,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"position", vault_state.key().as_ref(), &position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.vault == vault_state.key() @ ErrorCode::InvalidPosition,
        close = protocol,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub protocol: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Seeds for the new position PDA are derived from vault_state.next_position_id,
/// read from on-chain state before the instruction body executes. The client
/// must pre-read next_position_id to pass the correct position account address.
#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.protocol.as_ref()],
        bump = vault_state.bump,
        has_one = miner @ ErrorCode::WrongAuthority,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = miner,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", vault_state.key().as_ref(), &vault_state.next_position_id.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub miner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct ClosePosition<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.protocol.as_ref()],
        bump = vault_state.bump,
        has_one = miner @ ErrorCode::WrongAuthority,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"position", vault_state.key().as_ref(), &position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.vault == vault_state.key() @ ErrorCode::InvalidPosition,
        close = miner,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub miner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ── Custom errors ─────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not the expected authority for this instruction")]
    WrongAuthority,
    #[msg("Opening this position would exceed the deployment ceiling")]
    CeilingExceeded,
    #[msg("Position does not belong to this vault")]
    InvalidPosition,
    #[msg("Arithmetic overflow in liquidity calculation")]
    ArithmeticOverflow,
}
