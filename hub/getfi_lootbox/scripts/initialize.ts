/**
 * One-shot initializer for the GetFi lootbox program.
 *
 * Run this immediately after `anchor deploy` against a fresh program ID.
 * It calls `initialize_config` (binds the reward mint + designates the
 * backend Ed25519 signer that signs every box request) so the rest of the
 * client/bot fleet can start issuing requests.
 *
 * Re-running this against an already-initialized Config PDA fails — the
 * `init` constraint on `InitializeConfig` enforces single-shot creation.
 * To rotate the reward mint after launch, see `getfi_lootbox/MIGRATION.md`.
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// 1. Program ID + reward mint addresses
const PROGRAM_ID = new PublicKey("Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7");
const REWARD_TOKEN_MINT = new PublicKey("3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo");
const CLUSTER = "devnet";

// 2. Wallet + RPC connection
const walletPath = path.resolve(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config/solana/id.json",
);

const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet = Keypair.fromSecretKey(secretKey);

const connection = new anchor.web3.Connection(
  anchor.web3.clusterApiUrl(CLUSTER),
  "confirmed",
);

const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
  commitment: "confirmed",
});
anchor.setProvider(provider);

// 3. Load IDL
const idlPath = path.resolve(__dirname, "..", "target", "idl", "getfi_lootbox.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
const program = new anchor.Program(idl as any, provider);

// 4. Derive PDAs
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
const [inventoryPda] = PublicKey.findProgramAddressSync([Buffer.from("inventory")], PROGRAM_ID);

async function main() {
  console.log("-------------------------------------------------");
  console.log("Initializing Roll Raider lootbox economy");
  console.log("Admin wallet:        ", wallet.publicKey.toBase58());
  console.log("Config PDA (vault):  ", configPda.toBase58());
  console.log("Inventory PDA:       ", inventoryPda.toBase58());

  try {
    // The deployer is also the backend Ed25519 signer for the demo.
    const backendSigner = wallet.publicKey;

    const tx = await program.methods
      .initializeConfig(backendSigner)
      .accounts({
        owner: wallet.publicKey,
        config: configPda,
        inventory: inventoryPda,
        rewardMint: REWARD_TOKEN_MINT,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("\nInitialized. Tx:", tx);
    console.log("-------------------------------------------------");
    console.log("Now fund the on-chain vault. Run in your terminal:");
    console.log(`1. Create the vault token account:`);
    console.log(`   spl-token create-account ${REWARD_TOKEN_MINT.toBase58()} --owner ${configPda.toBase58()}`);
    console.log(`2. Transfer reward inventory into the vault:`);
    console.log(`   spl-token transfer ${REWARD_TOKEN_MINT.toBase58()} 10000000000 <VAULT_ADDRESS_FROM_STEP_1>`);
    console.log("-------------------------------------------------");
  } catch (err) {
    console.error("\nInitialization failed:", err);
  }
}

main().catch(console.error);
