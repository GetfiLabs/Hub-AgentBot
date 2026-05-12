/**
 * Vector Store Service — OpenAI Vector Store management
 *
 * Tasks:
 * - Create new Vector Store
 * - Upload game documents (PDF/Markdown/TXT) to Vector Store
 * - List current files
 * - Dynamically add QA pairs (Preparation for Step 4)
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ───────────────────────── Create Vector Store ─────────────────────────
/**
 * Creates a new Vector Store.
 * @param {string} name - Store name
 * @returns {Promise<object>} - Created store info
 */
async function createVectorStore(name = 'Raider Bot Knowledge Base') {
  try {
    const store = await openai.vectorStores.create({
      name,
    });

    console.log(`✅ Vector Store created: ${store.id}`);
    console.log(`   📋 Name: ${store.name}`);
    console.log(`   💡 Add this ID to your .env file as OPENAI_VECTOR_STORE_ID!`);

    return store;
  } catch (error) {
    console.error('❌ Vector Store creation error:', error.message);
    throw error;
  }
}

// ───────────────────────── File Upload ─────────────────────────
/**
 * Uploads a single file to the Vector Store and waits for processing.
 * @param {string} vectorStoreId - Target Vector Store ID
 * @param {string} filePath - Path of the file to upload
 * @returns {Promise<object>} - Uploaded file info
 */
async function uploadFile(vectorStoreId, filePath) {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const fileName = path.basename(absolutePath);
  console.log(`📤 Uploading file: ${fileName}...`);

  try {
    // Upload file to OpenAI
    const file = await openai.files.create({
      file: fs.createReadStream(absolutePath),
      purpose: 'assistants',
    });

    // Add to Vector Store and poll for processing
    const vectorStoreFile = await openai.vectorStores.files.createAndPoll(
      vectorStoreId,
      { file_id: file.id }
    );

    if (vectorStoreFile.status === 'completed') {
      console.log(`✅ ${fileName} successfully uploaded and processed.`);
    } else {
      console.warn(`⚠️ ${fileName} uploaded but status is: ${vectorStoreFile.status}`);
    }

    return vectorStoreFile;
  } catch (error) {
    console.error(`❌ File upload error (${fileName}):`, error.message);
    throw error;
  }
}

// ───────────────────────── Bulk File Upload ─────────────────────────
/**
 * Uploads all compatible files in a directory to the Vector Store.
 * Supported formats: .pdf, .md, .txt, .docx, .json
 * @param {string} vectorStoreId - Target Vector Store ID
 * @param {string} directoryPath - Folder containing the files
 * @returns {Promise<object[]>} - Information of the uploaded files
 */
async function uploadDirectory(vectorStoreId, directoryPath) {
  const absDir = path.resolve(directoryPath);

  if (!fs.existsSync(absDir)) {
    throw new Error(`Directory not found: ${absDir}`);
  }

  const supportedExtensions = ['.pdf', '.md', '.txt', '.docx', '.json'];
  const files = fs.readdirSync(absDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return supportedExtensions.includes(ext);
  });

  if (files.length === 0) {
    console.warn('⚠️ No compatible files found.');
    return [];
  }

  console.log(`📂 ${files.length} files found. Uploading...`);
  console.log('──────────────────────────────');

  const results = [];
  for (const file of files) {
    try {
      const result = await uploadFile(vectorStoreId, path.join(absDir, file));
      results.push(result);
    } catch (error) {
      console.error(`   ⏭️ ${file} skipped: ${error.message}`);
    }
  }

  console.log('──────────────────────────────');
  console.log(`✅ Total ${results.length}/${files.length} files uploaded.`);

  return results;
}

// ───────────────────────── Add QA Pair (Step 4: Persistent Learning) ─────────────────────────
/**
 * Adds a Q&A pair to the Vector Store as a text file.
 * This allows the bot to answer same/similar questions on its own in the future.
 * Also keeps a learning record in the database.
 * @param {string} vectorStoreId - Target Vector Store ID
 * @param {string} question - Question asked
 * @param {string} answer - Answer given by the team
 * @returns {Promise<object>}
 */
async function addQAPair(vectorStoreId, question, answer) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const content = `# Q&A Record (Team Response)

## Question:
${question}

## Answer:
${answer}

## Category: Answered by team — Raider Pass support info
## Record Date: ${new Date().toISOString()}
## Source: Developer team response (escalation)
`;

  try {
    // Create temporary file
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `qa_${timestamp}.md`);
    fs.writeFileSync(tempFile, content, 'utf-8');

    // Upload to Vector Store
    const result = await uploadFile(vectorStoreId, tempFile);

    // Clean up temporary file
    fs.unlinkSync(tempFile);

    // Add learning record to database
    const database = require('./database');
    const fileId = result.id || null;
    await database.logLearnedQA(question, answer, fileId);

    console.log('✅ QA pair added to knowledge base and saved to database.');
    return result;
  } catch (error) {
    console.error('❌ QA pair addition error:', error.message);
    throw error;
  }
}

// ───────────────────────── Store Info ─────────────────────────
/**
 * Lists files in the Vector Store.
 * @param {string} vectorStoreId
 * @returns {Promise<object[]>}
 */
async function listFiles(vectorStoreId) {
  try {
    const fileList = await openai.vectorStores.files.list(vectorStoreId);
    const files = [];

    for await (const file of fileList) {
      files.push({
        id: file.id,
        status: file.status,
        createdAt: file.created_at,
      });
    }

    console.log(`📚 There are ${files.length} files in the Vector Store.`);
    return files;
  } catch (error) {
    console.error('❌ File listing error:', error.message);
    throw error;
  }
}

// ───────────────────────── Exports ─────────────────────────
module.exports = {
  createVectorStore,
  uploadFile,
  uploadDirectory,
  addQAPair,
  listFiles,
};
