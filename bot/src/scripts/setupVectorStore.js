#!/usr/bin/env node

/**
 * Vector Store CLI — Knowledge base management tool
 *
 * Usage:
 *   node src/scripts/setupVectorStore.js create           → Create new Vector Store
 *   node src/scripts/setupVectorStore.js upload <file>   → Upload a single file
 *   node src/scripts/setupVectorStore.js upload-dir <dir> → Upload all files in a folder
 *   node src/scripts/setupVectorStore.js list              → List files in the Store
 */

require('dotenv').config();
const vectorStore = require('../services/vectorStore');

const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;

async function main() {
  const [,, command, ...args] = process.argv;

  console.log('🤖 Raider Bot — Vector Store Management');
  console.log('──────────────────────────────');

  switch (command) {
    case 'create': {
      const name = args[0] || 'Raider Bot Knowledge Base';
      const store = await vectorStore.createVectorStore(name);
      console.log('\n📝 Add this line to your .env file:');
      console.log(`   OPENAI_VECTOR_STORE_ID=${store.id}`);
      break;
    }

    case 'upload': {
      if (!VECTOR_STORE_ID) {
        console.error('❌ OPENAI_VECTOR_STORE_ID is not defined in the .env file!');
        console.error('   Create a store first with the "create" command.');
        process.exit(1);
      }
      if (!args[0]) {
        console.error('❌ No file path specified!');
        console.error('   Usage: node src/scripts/setupVectorStore.js upload <file_path>');
        process.exit(1);
      }
      await vectorStore.uploadFile(VECTOR_STORE_ID, args[0]);
      break;
    }

    case 'upload-dir': {
      if (!VECTOR_STORE_ID) {
        console.error('❌ OPENAI_VECTOR_STORE_ID is not defined in the .env file!');
        console.error('   Create a store first with the "create" command.');
        process.exit(1);
      }
      const dir = args[0] || './docs';
      await vectorStore.uploadDirectory(VECTOR_STORE_ID, dir);
      break;
    }

    case 'list': {
      if (!VECTOR_STORE_ID) {
        console.error('❌ OPENAI_VECTOR_STORE_ID is not defined in the .env file!');
        process.exit(1);
      }
      const files = await vectorStore.listFiles(VECTOR_STORE_ID);
      if (files.length > 0) {
        console.log('\n📋 Files:');
        files.forEach((f, i) => {
          console.log(`   ${i + 1}. ${f.id} [${f.status}]`);
        });
      }
      break;
    }

    default:
      console.log('📖 Usage:');
      console.log('   node src/scripts/setupVectorStore.js create            → Create new store');
      console.log('   node src/scripts/setupVectorStore.js upload <file>    → Upload single file');
      console.log('   node src/scripts/setupVectorStore.js upload-dir <dir>  → Upload folder');
      console.log('   node src/scripts/setupVectorStore.js list              → List files');
      break;
  }
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
