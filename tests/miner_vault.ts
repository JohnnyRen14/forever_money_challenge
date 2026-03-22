import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import { MinerVault } from "../target/types/miner_vault";
import { expect } from "chai";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derives the Position PDA for a given vault and numeric position ID.
 * Uses the same little-endian 8-byte encoding as the program (to_le_bytes).
 */
function derivePositionPda(
  vaultKey: anchor.web3.PublicKey,
  positionId: number,
  programId: anchor.web3.PublicKey
): [anchor.web3.PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(positionId));
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("position"), vaultKey.toBuffer(), idBuf],
    programId
  );
}

/**
 * Asserts that a promise rejects with a specific Anchor error code.
 */
async function expectAnchorError(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected '${code}' error but the transaction succeeded`);
  } catch (err) {
    if (err instanceof AnchorError) {
      expect(err.error.errorCode.code).to.equal(code);
    } else {
      throw err;
    }
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("miner_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MinerVault as Program<MinerVault>;

  // Wallets
  const protocol = provider.wallet as anchor.Wallet;
  const miner = anchor.web3.Keypair.generate();
  const newMiner = anchor.web3.Keypair.generate();
  const stranger = anchor.web3.Keypair.generate();

  // Ceiling: 1 000 liquidity units
  const CEILING = new anchor.BN("1000");

  // Vault PDA — seeds: ["vault", protocol]
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), protocol.publicKey.toBuffer()],
    program.programId
  );

  // ── Setup ─────────────────────────────────────────────────────────────────

  before(async () => {
    // On devnet airdrops are rate limited so we fund test wallets
    // directly from the provider wallet instead of requesting airdrops.
    const tx = new anchor.web3.Transaction();

    tx.add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: protocol.publicKey,
        toPubkey: miner.publicKey,
        lamports: 4 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );

    tx.add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: protocol.publicKey,
        toPubkey: newMiner.publicKey,
        lamports: 2 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );

    tx.add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: protocol.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 1 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );

    await provider.sendAndConfirm(tx);
  });

  // ── Test 4: happy-path initialization ────────────────────────────────────

  it("4 — protocol initializes vault with correct state", async () => {
    await program.methods
      .initializeVault(CEILING, miner.publicKey)
      .accounts({
        vaultState: vaultPda,
        protocol: protocol.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultPda);
    console.log("=================================");
    console.log("VaultState PDA:", vaultPda.toString());
    console.log("=================================");
    expect(vault.protocol.toString()).to.equal(protocol.publicKey.toString());
    expect(vault.miner.toString()).to.equal(miner.publicKey.toString());
    expect(vault.ceiling.toString()).to.equal(CEILING.toString());
    expect(vault.deployedL.toString()).to.equal("0");
    expect(vault.nextPositionId.toString()).to.equal("0");
  });

  // ── Test 1 (adversarial): miner calls set_ceiling ────────────────────────

  it("1 ★ miner calls set_ceiling → rejected (WrongAuthority)", async () => {
    await expectAnchorError(
      program.methods
        .setCeiling(new anchor.BN("9999"))
        .accounts({
          vaultState: vaultPda,
          protocol: miner.publicKey,
        } as any)
        .signers([miner])
        .rpc(),
      "WrongAuthority"
    );
  });

  // ── Test 3 (adversarial): protocol calls open_position ───────────────────

  it("3 ★ protocol calls open_position → rejected (WrongAuthority)", async () => {
    const [positionKey] = derivePositionPda(vaultPda, 0, program.programId);

    await expectAnchorError(
      program.methods
        .openPosition(-50, 50, new anchor.BN("100"))
        .accounts({
          vaultState: vaultPda,
          position: positionKey,
          miner: protocol.publicKey,
        } as any)
        .rpc(),
      "WrongAuthority"
    );
  });

  // ── Test 5: miner opens a valid position ─────────────────────────────────

  it("5 — miner opens valid position within ceiling (position 0)", async () => {
    const [positionKey] = derivePositionPda(vaultPda, 0, program.programId);
    console.log("=================================");
    console.log("Position PDA (id=0):", positionKey.toString());
    console.log("=================================");

    await program.methods
      .openPosition(-100, 100, new anchor.BN("500"))
      .accounts({
        vaultState: vaultPda,
        position: positionKey,
        miner: miner.publicKey,
      } as any)
      .signers([miner])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.deployedL.toString()).to.equal("500");
    expect(vault.nextPositionId.toString()).to.equal("1");

    const pos = await program.account.position.fetch(positionKey);
    expect(pos.id.toString()).to.equal("0");
    expect(pos.tickLower).to.equal(-100);
    expect(pos.tickUpper).to.equal(100);
    expect(pos.liquidity.toString()).to.equal("500");
    expect(pos.vault.toString()).to.equal(vaultPda.toString());
  });

  // ── Test 2 (adversarial): position would exceed ceiling ──────────────────

  it("2 ★ miner opens position exceeding ceiling → rejected (CeilingExceeded)", async () => {
    // deployed_l is currently 500; ceiling is 1000.
    // Requesting 501 more would push total to 1001 > 1000.
    const [positionKey] = derivePositionPda(vaultPda, 1, program.programId);

    await expectAnchorError(
      program.methods
        .openPosition(-200, 200, new anchor.BN("501"))
        .accounts({
          vaultState: vaultPda,
          position: positionKey,
          miner: miner.publicKey,
        } as any)
        .signers([miner])
        .rpc(),
      "CeilingExceeded"
    );

    // State must be unchanged after the rejection.
    const vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.deployedL.toString()).to.equal("500");
    expect(vault.nextPositionId.toString()).to.equal("1");
  });

  // ── Test 6: miner closes their own position ───────────────────────────────

  it("6 — miner closes their position → deployed_l decreases", async () => {
    const [positionKey] = derivePositionPda(vaultPda, 0, program.programId);

    await program.methods
      .closePosition(new anchor.BN(0))
      .accounts({
        vaultState: vaultPda,
        position: positionKey,
        miner: miner.publicKey,
      } as any)
      .signers([miner])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.deployedL.toString()).to.equal("0");

    const raw = await provider.connection.getAccountInfo(positionKey);
    expect(raw).to.be.null;
  });

  // ── Test 7: protocol force-closes a position ──────────────────────────────

  it("7 — protocol force-closes a miner position → deployed_l decreases", async () => {
    const [positionKey] = derivePositionPda(vaultPda, 1, program.programId);

    await program.methods
      .openPosition(-300, 300, new anchor.BN("400"))
      .accounts({
        vaultState: vaultPda,
        position: positionKey,
        miner: miner.publicKey,
      } as any)
      .signers([miner])
      .rpc();

    let vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.deployedL.toString()).to.equal("400");

    await program.methods
      .forceClosePosition(new anchor.BN(1))
      .accounts({
        vaultState: vaultPda,
        position: positionKey,
        protocol: protocol.publicKey,
      } as any)
      .rpc();

    vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.deployedL.toString()).to.equal("0");

    const raw = await provider.connection.getAccountInfo(positionKey);
    expect(raw).to.be.null;
  });

  // ── Test 8: close then reopen within freed capacity ───────────────────────

  it("8 — closing a position frees capacity to open a new one at the ceiling", async () => {
    const [pos2Key] = derivePositionPda(vaultPda, 2, program.programId);

    await program.methods
      .openPosition(-50, 50, new anchor.BN("1000"))
      .accounts({ vaultState: vaultPda, position: pos2Key, miner: miner.publicKey } as any)
      .signers([miner])
      .rpc();

    await program.methods
      .closePosition(new anchor.BN(2))
      .accounts({ vaultState: vaultPda, position: pos2Key, miner: miner.publicKey } as any)
      .signers([miner])
      .rpc();

    const [pos3Key] = derivePositionPda(vaultPda, 3, program.programId);
    await program.methods
      .openPosition(-50, 50, new anchor.BN("1000"))
      .accounts({ vaultState: vaultPda, position: pos3Key, miner: miner.publicKey } as any)
      .signers([miner])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.deployedL.toString()).to.equal("1000");

    await program.methods
      .closePosition(new anchor.BN(3))
      .accounts({ vaultState: vaultPda, position: pos3Key, miner: miner.publicKey } as any)
      .signers([miner])
      .rpc();
  });

  // ── Test 9: old miner rejected after rotation ─────────────────────────────

  it("9 — old miner is rejected after miner rotation", async () => {
    await program.methods
      .setMiner(newMiner.publicKey)
      .accounts({ vaultState: vaultPda, protocol: protocol.publicKey } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultPda);
    expect(vault.miner.toString()).to.equal(newMiner.publicKey.toString());

    const [positionKey] = derivePositionPda(vaultPda, 4, program.programId);
    await expectAnchorError(
      program.methods
        .openPosition(-10, 10, new anchor.BN("100"))
        .accounts({
          vaultState: vaultPda,
          position: positionKey,
          miner: miner.publicKey,
        } as any)
        .signers([miner])
        .rpc(),
      "WrongAuthority"
    );

    await program.methods
      .setMiner(miner.publicKey)
      .accounts({ vaultState: vaultPda, protocol: protocol.publicKey } as any)
      .rpc();
  });

  // ── Test 10: ceiling set below deployed_l blocks new opens ───────────────

  it("10 — ceiling below deployed_l prevents any new open", async () => {
    const [pos4Key] = derivePositionPda(vaultPda, 4, program.programId);

    await program.methods
      .openPosition(-10, 10, new anchor.BN("500"))
      .accounts({ vaultState: vaultPda, position: pos4Key, miner: miner.publicKey } as any)
      .signers([miner])
      .rpc();

    await program.methods
      .setCeiling(new anchor.BN("400"))
      .accounts({ vaultState: vaultPda, protocol: protocol.publicKey } as any)
      .rpc();

    const [pos5Key] = derivePositionPda(vaultPda, 5, program.programId);
    await expectAnchorError(
      program.methods
        .openPosition(-5, 5, new anchor.BN("1"))
        .accounts({ vaultState: vaultPda, position: pos5Key, miner: miner.publicKey } as any)
        .signers([miner])
        .rpc(),
      "CeilingExceeded"
    );

    await program.methods
      .closePosition(new anchor.BN(4))
      .accounts({ vaultState: vaultPda, position: pos4Key, miner: miner.publicKey } as any)
      .signers([miner])
      .rpc();

    await program.methods
      .setCeiling(new anchor.BN("1000"))
      .accounts({ vaultState: vaultPda, protocol: protocol.publicKey } as any)
      .rpc();
  });

  // ── Test 11: stranger is rejected from any instruction ────────────────────

  it("11 — stranger is rejected from every instruction", async () => {
    const [positionKey] = derivePositionPda(vaultPda, 5, program.programId);
    await expectAnchorError(
      program.methods
        .openPosition(-10, 10, new anchor.BN("100"))
        .accounts({
          vaultState: vaultPda,
          position: positionKey,
          miner: stranger.publicKey,
        } as any)
        .signers([stranger])
        .rpc(),
      "WrongAuthority"
    );

    await expectAnchorError(
      program.methods
        .setCeiling(new anchor.BN("9999"))
        .accounts({
          vaultState: vaultPda,
          protocol: stranger.publicKey,
        } as any)
        .signers([stranger])
        .rpc(),
      "WrongAuthority"
    );
  });
});