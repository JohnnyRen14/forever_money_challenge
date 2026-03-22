
# 🔐 miner_vault

### Permissioned Liquidity Vault · Solana 

A vault program that enforces strict role separation between **protocol admin** and **AI miner**, with atomic ceiling enforcement on liquidity deployments.

---

## 📖 Table of Contents

- [Ecosystem Context](#-ecosystem-context)
- [What This Program Does](#-what-this-program-does)
- [Architecture](#-architecture)
- [Instructions](#-instructions)
- [Permission Matrix](#-permission-matrix)
- [Part 1: Design](#-part-1-design)
- [Error Codes](#-error-codes)
- [Tests](#-tests)
- [Getting Started](#-getting-started)
- [Design Decisions](#-design-decisions)

---

## 🌐 Ecosystem Context

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Bittensor     │     │  ForeverMoney    │     │  Raydium CLMM  │
│                 │     │                  │     │                 │
│  AI miners  ───────►  │  picks winner ───────►  │  liquidity     │
│  compete for   │     │  executes        │     │  positions &    │
│  best strategy │     │  strategy        │     │  fees earned    │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                  │
                          ┌───────▼────────┐
                          │  miner_vault   │
                          │  (this program)│
                          │                │
                          │  holds funds   │
                          │  enforces rules│
                          └────────────────┘
```

| Layer | What It Is | Role |
|---|---|---|
| **Bittensor** | AI agent marketplace | Coordinates miners competing for best strategy |
| **ForeverMoney** | The bridge | Takes winning strategy and executes it on-chain |
| **Raydium** | CLMM DEX on Solana | Where liquidity is deployed and fees are earned |
| **miner_vault** | Proposed program | Holds capital safely, enforces all rules |

---

## 🏗 What This Program Does

Once deployed, any protocol can call `initialize_vault` to create their own vault. The program enforces three guarantees:

> **1. Role Separation** — Protocol and miner can only do their own job. Protocol can create vault, change the miner, adjust ceiling and force close position if needed. Miner then could only open and close positon.

> **2. Ceiling Enforcement** — The miner can never deploy more liquidity than the protocol allows. The check is atomic therefore impossible to race or split across transactions.

> **3. Non-Custodial Miner** — The miner has zero ability to withdraw funds as it just simply no function to do it. All funds is controlled in the token account which is a PDA.

This program can call multiple time by different protocols where each protocol gets their own completely isolated vault — separate VaultState, separate funds and separate miner.

---

## 🗂 Architecture

### Accounts Overview

```
miner_vault Program (deployed by us)
│
├── VaultState PDA          ← the rulebook
│   seeds: ["vault", protocol_pubkey]
│
├── Position PDA            ← created for each open position
│   seeds: ["position", vault_state_pubkey, position_id]
│
└── Token Account PDA       ← holds actual funds (production only)
    seeds: ["vault_token", vault_state_pubkey]
```

---

### VaultState PDA

> Seeds: `["vault", protocol_pubkey]`
> Created at: `initialize_vault` initialize_vault can only called by the protocol on the first time

| Field | Type | Description |
|---|---|---|
| `protocol` | `Pubkey` | Permanent admin authority, never changes |
| `miner` | `Pubkey` | Rotating operator — updatable via `set_miner` |
| `ceiling` | `u128` | Maximum active liquidity amount the miner may deploy  — only updatable by protocol via `set_ceiling`|
| `deployed_l` | `u128` | Running total of active open position liquidities |
| `next_position_id` | `u64` | Auto-incrementing counter used as unique position seed |
| `bump` | `u8` | Stored bump for gas-free PDA re-derivation |

---

### Position PDA

> Seeds: `["position", vault_state_pubkey, position_id_le_bytes]`
> Created at: `open_position` · Deleted at: `close_position` / `force_close_position`

| Field | Type | Description |
|---|---|---|
| `vault` | `Pubkey` | vault_state_address |
| `id` | `u64` | Unique ID copied from `next_position_id` at creation |
| `tick_lower` | `i32` | Bottom of the price range |
| `tick_upper` | `i32` | Top of the price range |
| `liquidity` | `u128` | Liquidity deployed in this position |
| `bump` | `u8` | Stored bump for gas-free PDA re-derivation |

> **Production note:** In a full Raydium integration, Position PDA would also store `nft_mint: Pubkey` — the NFT that Raydium mints to represent ownership of the liquidity position. When `open_position` CPIs into Raydium, Raydium returns this NFT mint address which gets stored here. When `close_position` is called, the program reads this NFT mint from the Position PDA and CPIs back into Raydium to burn it, returning tokens plus earned fees to the vault. If this isn't implemented we are not able to locate the position at Raydium.

---

### Token Account PDA _(Production Only)_

> Seeds: `["vault_token", vault_state_pubkey]`

**Not yet implemented in here** as LP operations are mocked per the challenge specification. In production this PDA would hold actual SPL tokens. No private key exists for it — only the program can move funds in or out via CPI.

---

## 📋 Instructions

### For Protocol and Only Protocol


initialize_vault

- Creates the `VaultState` PDA
- The signer becomes the **permanent** protocol authority
- The `miner` pubkey passed in becomes the initial operator
- `deployed_l` starts at `0`, `next_position_id` starts at `0`

set_ceiling

- Updates `VaultState.ceiling`
- Can be set above **or** below current `deployed_l`
- If set below current `deployed_l`, no new positions can be opened until capacity is freed

set_miner

- Updates `VaultState.miner` in place
- Funds and all existing Position PDAs are **completely untouched**
- **Only** Old miner instantly loses authority and New miner instantly gains it
- Therefore no fund migration required

force_close_position

- Emergency override — closes **any** position regardless of state
- Deletes the Position PDA, returns rent to protocol
- Subtracts position liquidity from `deployed_l`

---

### For Miner

open_position

- Checks signer is the current miner
- Atomically checks `deployed_l + liquidity <= ceiling` — **rejects if exceeded**
- Creates a Position PDA seeded with `next_position_id`
- Increments `next_position_id` and adds to `deployed_l`

close_position

- Checks signer is the current miner
- Verifies position belongs to this vault (cross-vault protection)
- Deletes the Position PDA, returns rent to miner
- Subtracts position liquidity from `deployed_l`

---

## 🔐 Permission Matrix

| Instruction | Protocol | Miner | Anyone Else |
|:---|:---:|:---:|:---:|
| `initialize_vault` | ✅ | ❌ | ❌ |
| `set_ceiling` | ✅ | ❌ | ❌ |
| `set_miner` | ✅ | ❌ | ❌ |
| `force_close_position` | ✅ | ❌ | ❌ |
| `open_position` | ❌ | ✅ | ❌ |
| `close_position` | ❌ | ✅ | ❌ |

Permissions are enforced via Anchor `has_one` which every instruction context validates the signer before any state is touched.

---

# Below is for Challenge **ForeverMoney (SN98) Solana Developer Challenge**

---

## 📐 Part 1: Design

### 1A — Permissioned Vault System on Solana

#### Solana Approach

**Existing tools used:**

| Tool | Why |
|---|---|
| **Anchor** | Accounts boilerplate. Industry standard. |
| **SPL Token** _(production)_ | Handles the Token Account PDA that holds actual funds. Industry standard. |
| **Squads Protocol v4** _(production)_ | Solana's equivalent of Gnosis Safe. In production, `vault.protocol` would be a Squads multisig PDA. No code changes required to upgrade from single keypair to Squads. |

**Custom Built:**

The `miner_vault` program is built by me. There is no exisiting tools in Solana equivalent of Zodiac Roles, so role separation is enforced natively in the program using Anchor `has_one` constraints on every instruction context.

**How the miner is prevented from withdrawing:**

In production, funds sit in Token Account PDA with no private key. The program have **no withdraw instruction** to the miner role. The miner can only call `open_position` and `close_position`. Even if the miner created a custom transaction targeting the token account directly, the program would reject it because the account is owned by the vault_state PDA.

In this implementation, operations are mocked therefore positions are pure data and no real tokens are deposited. 
Therefore no withdraw instruction is implemented for the protocol or the miner.
In production, a withdraw instruction would be added for the protocol only, together with the `has_one` constraint.

**How to change the miner without migrating funds:**

The protocol calls `set_miner(new_miner: Pubkey)`. Only `VaultState.miner` is updated in place. Funds, positions, ceiling and everything else is completely untouched. The key rotation is instant and atomic.

---

### 1B — Ceiling Enforcement

**How and where:**

The ceiling is implemented in the `VaultState` PDA inside same program.

```rust
// On every open_position — atomic with the state write:
let new_deployed = vault.deployed_l
    .checked_add(liquidity)
    .ok_or(ErrorCode::ArithmeticOverflow)?;
require!(new_deployed <= vault.ceiling, ErrorCode::CeilingExceeded);

// On every close_position / force_close_position:
vault.deployed_l = vault.deployed_l
    .checked_sub(position.liquidity)
    .ok_or(ErrorCode::ArithmeticOverflow)?;
```

**Why?**

Atomicity. If the ceiling lived in a separate program there would be a window between checking and acting. Inside one instruction the check and state update together.

**Can the miner split transactions to bypass the ceiling?**

No. `deployed_l` is an on-chain field read every time from the latest committed state at the start of each transaction. Each transaction is atomic and there is no stale read, no race condition, no split-transaction trick. The only way `deployed_l` decreases is when a position is closed.

---

## ⚠️ Error Codes

| Code | Message | When |
|---|---|---|
| `WrongAuthority` | Signer is not the expected authority | Wrong role calls an instruction |
| `CeilingExceeded` | Opening this position would exceed the deployment ceiling | `deployed_l + liquidity > ceiling` |
| `InvalidPosition` | Position does not belong to this vault | Cross-vault substitution attempt |
| `ArithmeticOverflow` | Arithmetic overflow in liquidity calculation | u128 overflow on add/sub |

---

## 🧪 Tests

### Main Cases

| # | Test | Expected |
|---|---|---|
| 1 ★ | Miner calls `set_ceiling` | `WrongAuthority` |
| 2 ★ | Miner opens position exceeding ceiling | `CeilingExceeded` |
| 3 ★ | Protocol calls `open_position` | `WrongAuthority` |

### Additional Cases

| # | Test | Expected |
|---|---|---|
| 4 | Protocol initializes vault | VaultState fields correct |
| 5 | Miner opens valid position | Position PDA created, `deployed_l` increases |
| 6 | Miner closes their position | Position PDA deleted, `deployed_l` decreases |
| 7 | Protocol `force_close_position` | Position PDA deleted, `deployed_l` decreases |
| 8 | Close then reopen within freed capacity | Succeeds |
| 9 | Old miner acts after `set_miner` | `WrongAuthority` |
| 10 | Ceiling set below `deployed_l`, new open attempted | `CeilingExceeded` |
| 11 | Stranger calls any instruction | `WrongAuthority` |

```
11 passing (6s) ✅
```

---

## 🚀 Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (nightly)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) 0.32.1
- Node.js + Yarn

### Install & Build

```bash
# Install JS dependencies
yarn install

# Build the program
anchor build

# Sync program ID into lib.rs and Anchor.toml
anchor keys sync

# Rebuild with correct program ID
anchor build
```

### Run Tests

```bash
anchor test
```

### Deploy to Devnet

```bash
# Switch to devnet
solana config set --url devnet

# Airdrop SOL for deployment fees
solana airdrop 2

# Update Anchor.toml cluster to devnet, then deploy
anchor deploy --provider.cluster devnet
```

---

## 💡 Design Decisions

**Running counter for `deployed_l` instead of summing positions at runtime**
A running counter is manipulation-resistant and O(1). Summing a list at runtime would require passing all position accounts in every transaction — complex and attackable by omitting accounts. The counter is always accurate, always atomic.

**Separate Position PDAs instead of a Vec on VaultState**
Solana accounts have a maximum size. A Vec would hit limits quickly. Separate PDAs are independently verifiable, deletable on close (rent returned), and findable by seeds in O(1) without scanning a list.

**Ceiling check in same instruction as position creation**
Atomicity. The check and the state write are a single atomic operation. There is no window to exploit between them.

**Positions store a vault backlink**
`position.vault` stores the VaultState address. This prevents cross-vault substitution attacks where a malicious actor passes a Position PDA from a different vault to manipulate another vault's `deployed_l` counter.

**NFT mint stored in Position PDA (production)**
In production, `open_position` CPIs into Raydium which returns an NFT mint representing ownership of the liquidity position. This NFT mint is stored in the Position PDA so `close_position` can CPI back into Raydium with the correct NFT to burn the position and retrieve funds plus fees.

**Squads for production, single keypair for this challenge**
Squads adds multisig security so no single key can drain the vault. The program code is identical — it just checks whoever is stored in `vault.protocol`. Upgrading requires no program changes, only a change to which pubkey is passed at `initialize_vault`.

---

---

## ⚠️ Implementation Disclaimer

This program is built for the ForeverMoney (SN98) Solana Developer Challenge.
LP operations are mocked per the challenge specification — positions are pure data `{ id, tick_lower, tick_upper, liquidity }`. 

The following are intentionally not implemented in this version:

| Feature | Reason | Production Plan |
|---|---|---|
| Token Account PDA | No real tokens in mocked version | SPL token account PDA holding actual funds |
| Withdraw instruction | No real tokens to withdraw | Protocol-only CPI to SPL token program |
| Raydium CPI | LP operations are mocked | `open_position` CPIs into Raydium CLMM, stores NFT mint in Position PDA |
| NFT mint storage | No real Raydium integration | Position PDA stores `nft_mint: Pubkey` returned by Raydium |

The security layer — role separation, ceiling enforcement, miner rotation and cross-vault protection — is fully implemented and production-ready.
---

## ⚠️ Implementation Disclaimer

This program is built for the ForeverMoney (SN98) Solana Developer Challenge.
LP operations are mocked per the challenge specification — positions are pure 
data `{ id, tick_lower, tick_upper, liquidity }`. 

The following are intentionally not implemented in this version:

| Feature | Reason | Production Plan |
|---|---|---|
| Token Account PDA | No real tokens in mocked version | SPL token account PDA holding actual funds |
| Withdraw instruction | No real tokens to withdraw | Protocol-only CPI to SPL token program |
| Raydium CPI | LP operations are mocked | `open_position` CPIs into Raydium CLMM, stores NFT mint in Position PDA |
| NFT mint storage | No real Raydium integration | Position PDA stores `nft_mint: Pubkey` returned by Raydium |

The security layer — role separation, ceiling enforcement, miner rotation, 
and cross-vault protection — is fully implemented and production-ready.
