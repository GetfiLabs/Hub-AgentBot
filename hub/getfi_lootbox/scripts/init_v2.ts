/**
 * Initialize the v2 inventory PDA for the lootbox program.
 *
 * Run once after `initialize.ts`. Creates the `inventory_v2` PDA which
 * holds the per-tier remaining stock counters used by `request_lootbox_batch`.
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GetfiLootbox;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [inventoryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("inventory_v2")],
    program.programId,
  );

  console.log("Initializing inventory v2");
  console.log("Program ID:        ", program.programId.toBase58());
  console.log("Inventory v2 PDA:  ", inventoryPda.toBase58());

  try {
    const tx = await program.methods
      .initializeInventoryV2()
      .accounts({
        owner: provider.wallet.publicKey,
        config: configPda,
        inventory: inventoryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Inventory v2 initialized. Tx:", tx);
  } catch (err) {
    console.error("Initialization failed:", err);
  }
}

main();
