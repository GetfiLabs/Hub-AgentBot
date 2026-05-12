// Phase 3 — agent delegation + fuel vault.
//
// These tests cover register_agent, revoke_agent, deposit_fuel, and
// withdraw_fuel end-to-end. They run against whatever cluster the
// AnchorProvider is pointed at (`anchor test` defaults to localnet,
// where the program is deployed fresh and the four ixs above don't
// depend on Config / GlobalInventory / the GET mint).
//
// open_box_as_agent is intentionally NOT tested here. It needs the
// initialized Config + the live GET mint + a funded reward vault token
// account, and the program hardcodes the mint pubkey so localnet can
// only run it via a `solana-test-validator --clone` fork. Its happy
// path is covered by `tests/agent_integration.ts`, which targets the
// devnet deployment after `anchor deploy`.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const AGENT_SEED = Buffer.from("agent");
const FUEL_SEED = Buffer.from("fuel");
const ONE_DAY = 86_400;

const AGENT_ACTION_OPEN_BOX = 1;

function deriveAgent(programId: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([AGENT_SEED, user.toBuffer()], programId)[0];
}

function deriveFuel(programId: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([FUEL_SEED, user.toBuffer()], programId)[0];
}

// Catches an AnchorError thrown by `.rpc()` and checks the error code
// string. Uses substring match so we can assert against either the
// `errorCode.code` enum name or the on-chain error message.
async function expectAnchorError(promise: Promise<any>, needle: string) {
  let caught: any = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  if (!caught) {
    throw new Error(`expected error containing '${needle}' but tx succeeded`);
  }
  const blob = `${caught}\n${JSON.stringify(caught?.error ?? {})}\n${JSON.stringify(caught?.logs ?? [])}`;
  expect(blob).to.include(needle);
}

describe("getfi_lootbox — Phase 3 agent + fuel", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "..", "target", "idl", "getfi_lootbox.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl as any, provider);
  const programId = program.programId;

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  async function createFundedUser(sol = 2): Promise<Keypair> {
    const kp = Keypair.generate();
    await airdrop(kp.publicKey, sol);
    return kp;
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function inDays(days: number) {
    return new BN(nowSec() + days * ONE_DAY);
  }

  async function registerFreshAgent(
    user: Keypair,
    agentPubkey: PublicKey,
    opts: { allowedActions?: number; expiryDelaySec?: number } = {},
  ) {
    const allowed = opts.allowedActions ?? AGENT_ACTION_OPEN_BOX;
    const expiry = new BN(nowSec() + (opts.expiryDelaySec ?? 30 * ONE_DAY));
    const agentPda = deriveAgent(programId, user.publicKey);
    await program.methods
      .registerAgent(agentPubkey, allowed, expiry)
      .accounts({
        user: user.publicKey,
        agentAuthority: agentPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([user])
      .rpc();
    return { agentPda, expiry };
  }

  // ── register_agent ────────────────────────────────────────────────────────

  describe("register_agent", () => {
    it("happy path — initializes AgentAuthority within the max-duration window", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const { agentPda, expiry } = await registerFreshAgent(user, agent.publicKey);

      const auth = await program.account.agentAuthority.fetch(agentPda);
      expect(auth.user.toBase58()).to.equal(user.publicKey.toBase58());
      expect(auth.agentPubkey.toBase58()).to.equal(agent.publicKey.toBase58());
      expect(auth.allowedActions).to.equal(AGENT_ACTION_OPEN_BOX);
      expect(auth.expiryTs.toString()).to.equal(expiry.toString());
      expect(auth.nonceCounter.toString()).to.equal("0");
      expect(auth.revoked).to.equal(false);
      expect(auth.bump).to.be.greaterThan(0);
    });

    it("rejects past expiry", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const agentPda = deriveAgent(programId, user.publicKey);
      const expired = new BN(nowSec() - 60);
      await expectAnchorError(
        program.methods
          .registerAgent(agent.publicKey, AGENT_ACTION_OPEN_BOX, expired)
          .accounts({
            user: user.publicKey,
            agentAuthority: agentPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        "AgentInvalidExpiry",
      );
    });

    it("rejects expiry > 365 days", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const agentPda = deriveAgent(programId, user.publicKey);
      const tooFar = new BN(nowSec() + (366 * ONE_DAY));
      await expectAnchorError(
        program.methods
          .registerAgent(agent.publicKey, AGENT_ACTION_OPEN_BOX, tooFar)
          .accounts({
            user: user.publicKey,
            agentAuthority: agentPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        "AgentInvalidExpiry",
      );
    });

    it("rejects empty allowed_actions mask", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const agentPda = deriveAgent(programId, user.publicKey);
      await expectAnchorError(
        program.methods
          .registerAgent(agent.publicKey, 0, inDays(30))
          .accounts({
            user: user.publicKey,
            agentAuthority: agentPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        "AgentInvalidActions",
      );
    });

    it("rejects unknown bits in allowed_actions mask", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const agentPda = deriveAgent(programId, user.publicKey);
      // Bit 0 is OPEN_BOX (known); bit 1 is reserved/unknown.
      const unknownBits = AGENT_ACTION_OPEN_BOX | (1 << 1);
      await expectAnchorError(
        program.methods
          .registerAgent(agent.publicKey, unknownBits, inDays(30))
          .accounts({
            user: user.publicKey,
            agentAuthority: agentPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        "AgentInvalidActions",
      );
    });

    it("rejects re-registration on same user (PDA already exists)", async () => {
      const user = await createFundedUser();
      const agent1 = Keypair.generate();
      const agent2 = Keypair.generate();
      await registerFreshAgent(user, agent1.publicKey);

      const agentPda = deriveAgent(programId, user.publicKey);
      // Anchor's `init` constraint surfaces this as an already-in-use error.
      await expectAnchorError(
        program.methods
          .registerAgent(agent2.publicKey, AGENT_ACTION_OPEN_BOX, inDays(30))
          .accounts({
            user: user.publicKey,
            agentAuthority: agentPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        // Anchor surfaces this as either "already in use" or "custom program error: 0x0".
        // Match on the generic substring that's stable across Anchor versions.
        "in use",
      );
    });
  });

  // ── revoke_agent ──────────────────────────────────────────────────────────

  describe("revoke_agent", () => {
    it("user can revoke their own agent", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const { agentPda } = await registerFreshAgent(user, agent.publicKey);

      await program.methods
        .revokeAgent()
        .accounts({
          authority: user.publicKey,
          user: user.publicKey,
          agentAuthority: agentPda,
        } as any)
        .signers([user])
        .rpc();

      const auth = await program.account.agentAuthority.fetch(agentPda);
      expect(auth.revoked).to.equal(true);
    });

    it("agent can self-revoke (the /istifa case)", async () => {
      const user = await createFundedUser();
      const agent = await createFundedUser(0.5); // needs gas to sign
      const { agentPda } = await registerFreshAgent(user, agent.publicKey);

      await program.methods
        .revokeAgent()
        .accounts({
          authority: agent.publicKey,
          user: user.publicKey,
          agentAuthority: agentPda,
        } as any)
        .signers([agent])
        .rpc();

      const auth = await program.account.agentAuthority.fetch(agentPda);
      expect(auth.revoked).to.equal(true);
    });

    it("third-party cannot revoke", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      const stranger = await createFundedUser(0.5);
      const { agentPda } = await registerFreshAgent(user, agent.publicKey);

      await expectAnchorError(
        program.methods
          .revokeAgent()
          .accounts({
            authority: stranger.publicKey,
            user: user.publicKey,
            agentAuthority: agentPda,
          } as any)
          .signers([stranger])
          .rpc(),
        "AgentAuthorityMismatch",
      );

      const auth = await program.account.agentAuthority.fetch(agentPda);
      expect(auth.revoked).to.equal(false);
    });
  });

  // ── deposit_fuel ──────────────────────────────────────────────────────────

  describe("deposit_fuel", () => {
    it("happy path — moves SOL from user into the FuelVault PDA", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      await registerFreshAgent(user, agent.publicKey);

      const agentPda = deriveAgent(programId, user.publicKey);
      const fuelPda = deriveFuel(programId, user.publicKey);
      const balBefore = await provider.connection.getBalance(fuelPda);
      expect(balBefore).to.equal(0);

      const amt = 0.05 * LAMPORTS_PER_SOL;
      await program.methods
        .depositFuel(new BN(amt))
        .accounts({
          user: user.publicKey,
          agentAuthority: agentPda,
          fuelVault: fuelPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();

      const balAfter = await provider.connection.getBalance(fuelPda);
      expect(balAfter).to.equal(amt);
    });

    it("rejects zero-lamport deposit", async () => {
      const user = await createFundedUser();
      const agent = Keypair.generate();
      await registerFreshAgent(user, agent.publicKey);
      const agentPda = deriveAgent(programId, user.publicKey);
      const fuelPda = deriveFuel(programId, user.publicKey);

      await expectAnchorError(
        program.methods
          .depositFuel(new BN(0))
          .accounts({
            user: user.publicKey,
            agentAuthority: agentPda,
            fuelVault: fuelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        "FuelInsufficient",
      );
    });

    it("rejects deposit when no agent registered", async () => {
      const orphan = await createFundedUser();
      const agentPda = deriveAgent(programId, orphan.publicKey);
      const fuelPda = deriveFuel(programId, orphan.publicKey);

      await expectAnchorError(
        program.methods
          .depositFuel(new BN(1000))
          .accounts({
            user: orphan.publicKey,
            agentAuthority: agentPda,
            fuelVault: fuelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([orphan])
          .rpc(),
        // AccountNotInitialized — Anchor returns this when the seeds-derived
        // PDA hasn't been created yet via `init`.
        "AccountNotInitialized",
      );
    });
  });

  // ── withdraw_fuel ─────────────────────────────────────────────────────────

  describe("withdraw_fuel", () => {
    async function setupWithFuel(amountSol = 0.1) {
      const user = await createFundedUser();
      const agent = await createFundedUser(0.5);
      await registerFreshAgent(user, agent.publicKey);

      const agentPda = deriveAgent(programId, user.publicKey);
      const fuelPda = deriveFuel(programId, user.publicKey);
      await program.methods
        .depositFuel(new BN(amountSol * LAMPORTS_PER_SOL))
        .accounts({
          user: user.publicKey,
          agentAuthority: agentPda,
          fuelVault: fuelPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();

      return { user, agent, agentPda, fuelPda };
    }

    it("user drains the entire vault (amount = None)", async () => {
      const { user, agentPda, fuelPda } = await setupWithFuel(0.1);
      const fuelBefore = await provider.connection.getBalance(fuelPda);
      const userBefore = await provider.connection.getBalance(user.publicKey);

      await program.methods
        .withdrawFuel(null)
        .accounts({
          authority: user.publicKey,
          user: user.publicKey,
          agentAuthority: agentPda,
          fuelVault: fuelPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();

      const fuelAfter = await provider.connection.getBalance(fuelPda);
      const userAfter = await provider.connection.getBalance(user.publicKey);
      expect(fuelAfter).to.equal(0);
      // User balance went up by ~fuelBefore minus tx fee (~5_000 lamports).
      expect(userAfter - userBefore).to.be.greaterThan(fuelBefore - 50_000);
    });

    it("user partial withdraw leaves the remainder in the vault", async () => {
      const { user, agentPda, fuelPda } = await setupWithFuel(0.1);
      const fuelBefore = await provider.connection.getBalance(fuelPda);
      const partial = Math.floor(fuelBefore / 4);

      await program.methods
        .withdrawFuel(new BN(partial))
        .accounts({
          authority: user.publicKey,
          user: user.publicKey,
          agentAuthority: agentPda,
          fuelVault: fuelPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();

      const fuelAfter = await provider.connection.getBalance(fuelPda);
      expect(fuelAfter).to.equal(fuelBefore - partial);
    });

    it("agent can withdraw — funds go to user, never to agent", async () => {
      const { user, agent, agentPda, fuelPda } = await setupWithFuel(0.1);
      const fuelBefore = await provider.connection.getBalance(fuelPda);
      const userBefore = await provider.connection.getBalance(user.publicKey);
      const agentBefore = await provider.connection.getBalance(agent.publicKey);

      await program.methods
        .withdrawFuel(null)
        .accounts({
          authority: agent.publicKey,
          user: user.publicKey,
          agentAuthority: agentPda,
          fuelVault: fuelPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      const userAfter = await provider.connection.getBalance(user.publicKey);
      const agentAfter = await provider.connection.getBalance(agent.publicKey);
      // User received the full vault balance.
      expect(userAfter - userBefore).to.equal(fuelBefore);
      // Core invariant: the agent never gains funds from a withdraw.
      // Provider.wallet pays the tx fee in this test harness, so the
      // agent's balance is unchanged — the strict assertion is that it
      // did not increase.
      expect(agentAfter).to.be.at.most(agentBefore);
    });

    it("rejects amount > vault balance", async () => {
      const { user, agentPda, fuelPda } = await setupWithFuel(0.05);
      const fuelBefore = await provider.connection.getBalance(fuelPda);

      await expectAnchorError(
        program.methods
          .withdrawFuel(new BN(fuelBefore + 1))
          .accounts({
            authority: user.publicKey,
            user: user.publicKey,
            agentAuthority: agentPda,
            fuelVault: fuelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([user])
          .rpc(),
        "FuelWithdrawTooLarge",
      );
    });

    it("rejects third-party signer", async () => {
      const { user, agentPda, fuelPda } = await setupWithFuel(0.05);
      const stranger = await createFundedUser(0.5);

      await expectAnchorError(
        program.methods
          .withdrawFuel(null)
          .accounts({
            authority: stranger.publicKey,
            user: user.publicKey,
            agentAuthority: agentPda,
            fuelVault: fuelPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([stranger])
          .rpc(),
        "AgentAuthorityMismatch",
      );
    });
  });

  // ── open_box_as_agent ─────────────────────────────────────────────────────
  // Skipped here — covered by tests/agent_integration.ts on devnet, where
  // the live Config + GET mint + funded reward vault already exist.
  describe.skip("open_box_as_agent (integration → tests/agent_integration.ts on devnet)", () => {});
});
