# miner_vault

A permissioned liquidity vault program on Solana, built for the ForeverMoney (SN98) Developer Challenge.

---

## Ecosystem Context

ForeverMoney is an automated liquidity manager built on Bittensor. Here is how the three layers fit together:

```
Bittensor (SN98)          ForeverMoney              Raydium CLMM
AI miners compete    →    picks winner,         →    actual liquidity
for best strategy         executes strategy          positions & fees
                               ↑
                        miner_vault lives here
```

- **Bittensor** — AI marketplace where miners compete to produce the best liquidity strategy
- **ForeverMoney** — the bridge that takes the winning strategy and executes it on-chain
- **Raydium** — the CLMM pool where liquidity actually gets deployed and fees are earned

---

## What This Program Does

Once deployed, any protocol can call `initialize_vault` to create their own vault. The protocol passes in a miner pubkey and a ceiling. From that point:

- The **protocol** controls the vault rules (ceiling, miner, emergency close)
- The **miner** (an AI bot wallet) can open and close liquidity positions
- The **funds** sit in a PDA — no private key exists, only the program can touch them
- The **miner cannot withdraw** — there is simply no instruction for that

Multiple protocols can use the same deployed program. Each gets their own completely separate vault with their own funds, miner, and positions.

---

## How Accounts Work

This program creates and controls three types of PDA accounts:

### VaultState PDA
Seeds: `["vault", protocol_pubkey]`

The rulebook. Created once when the protocol calls `initialize_vault`. Stores:

```
protocol          → who is the boss (set at init, cannot change)
miner             → which wallet can open/close positions
ceiling           → max liquidity the miner can deploy (in L units)
deployed_l        → running total of liquidity currently in open positions
next_position_id  → auto-incrementing counter that gives each position a unique ID
bump              → PDA bump seed stored for lookups
```

### Token Account PDA
Seeds: `["vault_token", vault_state_pubkey]`

The safe. Holds the actual tokens (funds). No private key exists for it — only the program can move tokens in or out. Created once at `initialize_vault`.

### Position PDA
Seeds: `["position", vault_state_pubkey, position_id]`

One created per open position. Stores:

```
vault       → which vault this position belongs to (prevents cross-vault attacks)
id          → unique position ID (from next_position_id counter)
tick_lower  → bottom of the price range
tick_upper  → top of the price range
liquidity   → how much L is deployed in this position
bump        → PDA bump seed stored for lookups
```

Created when miner calls `open_position`. Deleted when miner calls `close_position` or protocol calls `force_close_position`.

---

## Instructions

### Protocol Only

**`initialize_vault(ceiling_l: u128, miner: Pubkey)`**
- Creates the VaultState PDA and Token Account PDA
- The signer becomes the permanent protocol authority
- The miner pubkey passed in becomes the operator
- Sets ceiling and deployed_l starts at 0

**`set_ceiling(new_ceiling_l: u128)`**
- Updates the ceiling in VaultState
- Can be set above or below current deployed_l
- If set below current deployed_l, no new positions can be opened until enough are closed

**`force_close_position(position_id: u64)`**
- Protocol emergency override
- Closes any position regardless of who opened it
- Deletes the Position PDA
- Subtracts the position liquidity from deployed_l

### Miner Only

**`open_position(tick_lower: i32, tick_upper: i32, liquidity: u128)`**
- Checks signer is the current miner
- Checks deployed_l + liquidity <= ceiling, rejects if not
- Creates a Position PDA using next_position_id as seed
- Increments next_position_id in VaultState
- Adds liquidity to deployed_l

**`close_position(position_id: u64)`**
- Checks signer is the current miner
- Checks the position belongs to this vault
- Deletes the Position PDA (rent returned)
- Subtracts position liquidity from deployed_l

---

## Permission Matrix

| Instruction | Protocol | Miner | Anyone Else |
|---|---|---|---|
| `initialize_vault` | ✅ | ❌ | ❌ |
| `set_ceiling` | ✅ | ❌ | ❌ |
| `force_close_position` | ✅ | ❌ | ❌ |
| `open_position` | ❌ | ✅ | ❌ |
| `close_position` | ❌ | ✅ | ❌ |

---

## Part 1: Design

### 1A. Permissioned Vault System on Solana

#### What existing tools are used and why

**Anchor framework** — handles account validation boilerplate automatically, prevents account confusion attacks, and generates an IDL for frontend integration. Industry standard for Solana programs.

**SPL Token program** — handles the token account PDA that holds actual funds. Battle-tested, no need to build custom token handling.

**Squads Protocol v4 (production)** — in production the protocol authority stored in VaultState would be a Squads multisig PDA rather than a single keypair. Squads is the Solana equivalent of Gnosis Safe — multiple team members must co-sign before any admin action goes through. This ensures no single person can unilaterally drain the vault. For this challenge the protocol is a single keypair for simplicity, but switching to Squads requires zero program code changes — the program just checks whoever is stored in `vault.protocol`.

#### What is built custom

The `miner_vault` program itself. There is no Solana equivalent of Zodiac Roles, so role separation is enforced directly in the program logic using signer checks on every instruction.

#### How the miner is prevented from withdrawing

The tokens sit in a Token Account PDA — no private key exists for it. The program exposes no withdraw instruction to the miner role. The miner can only call `open_position` and `close_position`, which track liquidity deployments but never transfer tokens to external wallets. Even if the miner tried to craft a custom transaction targeting the token account, the program would reject it because the account is owned by the program PDA.

#### How to change the miner without migrating funds

The protocol calls `set_miner(new_miner: Pubkey)` which updates `VaultState.miner` in place. The Token Account PDA and all funds are completely untouched. All existing Position PDAs remain open. The old miner key instantly loses all authority and the new miner key instantly gains it.

---

### 1B. Ceiling Enforcement

#### How and where the ceiling is enforced

The ceiling lives inside the `miner_vault` program on the VaultState PDA. Two fields work together:

- `ceiling` — set by the protocol, can be updated anytime
- `deployed_l` — running total of all currently open position liquidities

On every `open_position` call before any state changes:

```rust
require!(
    vault.deployed_l.checked_add(liquidity).unwrap() <= vault.ceiling,
    ErrorCode::CeilingExceeded
);
```

On every `close_position` or `force_close_position`:

```rust
vault.deployed_l = vault.deployed_l.checked_sub(position.liquidity).unwrap();
```

#### Does it live in the vault system or a separate layer

It lives inside the same program on the same VaultState PDA. Keeping it in one place means the ceiling check is atomic with the position creation — there is no window between checking and acting where something could slip through.

#### Can the miner split transactions to bypass the ceiling

No. `deployed_l` is a persistent on-chain field read fresh at the start of every transaction. Each transaction is atomic — it either fully succeeds or fully reverts. There is no way to read a stale version of `deployed_l`. Even sending many transactions in parallel, each one reads the latest committed state. The only way `deployed_l` decreases is when a position is actually closed.

---

## Error Codes

| Error | When It Triggers |
|---|---|
| `WrongAuthority` | Signer is not the expected role for that instruction |
| `CeilingExceeded` | open_position would push deployed_l over ceiling |
| `InvalidPosition` | Position does not belong to this vault |
| `ArithmeticOverflow` | Liquidity math overflow |

---

## Tests

### Required Adversarial Tests

1. **Miner calls `set_ceiling`** → rejected (`WrongAuthority`)
2. **Miner opens position that would exceed ceiling** → rejected (`CeilingExceeded`)
3. **Protocol calls `open_position`** → rejected (`WrongAuthority`)

### Additional Tests

4. Protocol initializes vault → VaultState created with correct fields
5. Miner opens valid position within ceiling → Position PDA created, deployed_l increases
6. Miner closes their position → Position PDA deleted, deployed_l decreases
7. Protocol force-closes a miner position → Position PDA deleted, deployed_l decreases
8. Miner closes position then opens new one within freed capacity → allowed
9. Old miner tries to act after miner is rotated → rejected (`WrongAuthority`)
10. Ceiling set below current deployed_l, miner tries to open new position → rejected (`CeilingExceeded`)
11. Unknown signer calls any instruction → rejected (`WrongAuthority`)

---

## Running The Program

```bash
# Install dependencies
npm install

# Build
anchor build

# Run tests
anchor test
```

---

## Design Decisions

**Why a running counter for deployed_l instead of summing positions at runtime**
A running counter is manipulation-resistant. Summing a list at runtime would require passing all position accounts in every transaction, which is complex and attackable by passing incomplete account lists. The counter is always accurate and atomic.

**Why separate Position PDAs instead of a Vec on VaultState**
Solana accounts have a maximum size. A Vec would hit limits quickly with many open positions. Separate PDAs are independently verifiable, deletable on close (rent returned), and findable by seeds without scanning a list.

**Why the ceiling check lives in the same program and not a separate layer**
Atomicity. If the ceiling lived in a separate program, there would be a gap between checking and acting. Inside one instruction the check and state change happen together or not at all.

**Why LP operations are mocked**
Positions are pure data `{ id, tick_lower, tick_upper, liquidity }`. No real Raydium CPI is required for this challenge. In production, `open_position` would CPI into the Raydium CLMM program to mint a real position and `close_position` would burn it.

**Why Squads for production but not for this challenge**
Squads adds multisig security to the protocol authority so no single key can drain the vault. The program code does not change at all — it just checks whoever is stored in `vault.protocol`. Upgrading from a single keypair to Squads in production requires no program changes, only a change to which pubkey is passed at `initialize_vault`.
