import { AutoModel, AutoTokenizer, matmul } from "@huggingface/transformers"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { sql } from "drizzle-orm"
import { sqliteTable, integer, text, customType } from "drizzle-orm/sqlite-core"

// --- Vector Type Definition for Turso/libSQL ---

const EMBEDDING_DIMENSIONS = 768 // embeddinggemma-300m outputs 768-dimensional vectors

const float32Array = customType<{
  data: number[]
  config: { dimensions: number }
  configRequired: true
  driverData: Buffer
}>({
  dataType(config) {
    return `F32_BLOB(${config.dimensions})`
  },
  fromDriver(value: Buffer) {
    return Array.from(new Float32Array(value.buffer))
  },
  toDriver(value: number[]) {
    return sql`vector32(${JSON.stringify(value)})`
  },
})

// --- Schema Definition ---

const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
})

// --- Main Experiment ---

const main = async () => {
  console.log("🚀 Starting Vector Search Experiment with Turso + Drizzle + HuggingFace")
  console.log("=" .repeat(70))

  // 1. Initialize the embedding model
  console.log("\n📦 Loading embedding model (embeddinggemma-300m)...")
  const modelId = "onnx-community/embeddinggemma-300m-ONNX"
  const tokenizer = await AutoTokenizer.from_pretrained(modelId)
  const model = await AutoModel.from_pretrained(modelId, {
    dtype: "fp32",
  })
  console.log("✅ Model loaded successfully")

  // 2. Initialize Turso/libSQL database (local file for this experiment)
  console.log("\n🗄️  Initializing local libSQL database...")
  const client = createClient({
    url: "file:./vector-experiment.db",
  })
  const db = drizzle(client)

  // 3. Create table and vector index
  console.log("📋 Creating documents table with vector column...")
  await client.execute(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      embedding F32_BLOB(${EMBEDDING_DIMENSIONS})
    )
  `)

  // Drop existing index if any and create new one
  await client.execute(`DROP INDEX IF EXISTS documents_embedding_idx`)
  await client.execute(`
    CREATE INDEX documents_embedding_idx
    ON documents(libsql_vector_idx(embedding))
  `)
  console.log("✅ Table and vector index created")

  // 4. Define our document corpus
  const prefixes = {
    query: "task: search result | query: ",
    document: "title: none | text: ",
  }

  const documentTexts = [
    "Venus is often called Earth's twin because of its similar size and proximity.",
    "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
    "Jupiter, the largest planet in our solar system, has a prominent red spot.",
    "Saturn, famous for its rings, is sometimes mistaken for the Red Planet.",
    "The Moon is Earth's only natural satellite and the fifth largest moon in the solar system.",
    "Mercury is the smallest planet in our solar system and closest to the Sun.",
    "Neptune is the eighth and farthest known planet from the Sun in our solar system.",
    "Uranus is unique for rotating on its side, with an axial tilt of about 98 degrees.",
  ]

  // 5. Generate embeddings for documents
  console.log("\n🔢 Generating embeddings for documents...")
  const docInputs = documentTexts.map((doc) => prefixes.document + doc)
  const docTokens = await tokenizer(docInputs, { padding: true })
  const docEmbeddings = await model(docTokens)
  const docVectors: number[][] = docEmbeddings.sentence_embedding.tolist()
  console.log(`✅ Generated ${docVectors.length} document embeddings (${EMBEDDING_DIMENSIONS} dimensions each)`)

  // 6. Clear existing data and insert documents with embeddings
  console.log("\n💾 Storing documents with embeddings in Turso...")
  await client.execute(`DELETE FROM documents`)

  for (let i = 0; i < documentTexts.length; i++) {
    const vectorJson = JSON.stringify(docVectors[i])
    await client.execute({
      sql: `INSERT INTO documents (content, embedding) VALUES (?, vector32(?))`,
      args: [documentTexts[i], vectorJson],
    })
  }
  console.log(`✅ Stored ${documentTexts.length} documents`)

  // 7. Perform vector search queries
  const queries = [
    "Which planet is known as the Red Planet?",
    "What is the largest planet?",
    "Tell me about Earth's satellite",
    "Which planet has rings?",
  ]

  console.log("\n" + "=".repeat(70))
  console.log("🔍 PERFORMING VECTOR SIMILARITY SEARCHES")
  console.log("=".repeat(70))

  for (const queryText of queries) {
    console.log(`\n📝 Query: "${queryText}"`)
    console.log("-".repeat(50))

    // Generate embedding for query
    const queryInput = prefixes.query + queryText
    const queryTokens = await tokenizer([queryInput], { padding: true })
    const queryEmbedding = await model(queryTokens)
    const queryVector: number[] = queryEmbedding.sentence_embedding.tolist()[0]

    // Perform vector search using vector_top_k
    const results = await client.execute({
      sql: `
        SELECT
          documents.id,
          documents.content,
          vector_distance_cos(documents.embedding, vector32(?)) as distance
        FROM vector_top_k('documents_embedding_idx', vector32(?), 3) AS vt
        JOIN documents ON documents.rowid = vt.id
        ORDER BY distance ASC
      `,
      args: [JSON.stringify(queryVector), JSON.stringify(queryVector)],
    })

    console.log("Top 3 results:")
    results.rows.forEach((row, idx) => {
      const similarity = 1 - (row.distance as number) // Convert distance to similarity
      console.log(`  ${idx + 1}. [sim: ${similarity.toFixed(4)}] ${row.content}`)
    })
  }

  // 8. Compare with in-memory computation (like the original example)
  console.log("\n" + "=".repeat(70))
  console.log("🧮 COMPARISON: In-memory vs Database Search")
  console.log("=".repeat(70))

  const testQuery = "Which planet is known as the Red Planet?"
  console.log(`\nQuery: "${testQuery}"`)

  // Generate combined embeddings for query + all docs
  const allInputs = [prefixes.query + testQuery, ...docInputs]
  const allTokens = await tokenizer(allInputs, { padding: true })
  const { sentence_embedding } = await model(allTokens)

  // Compute in-memory similarities using matmul
  const scores = await matmul(sentence_embedding, sentence_embedding.transpose(1, 0))
  const similarities: number[] = scores.tolist()[0].slice(1)

  const ranking = similarities
    .map((score: number, index: number) => ({ index, score, content: documentTexts[index] }))
    .sort((a, b) => b.score - a.score)

  console.log("\nIn-memory ranking (matmul):")
  ranking.slice(0, 3).forEach((item, idx) => {
    console.log(`  ${idx + 1}. [sim: ${item.score.toFixed(4)}] ${item.content}`)
  })

  // Database ranking
  const queryTokens2 = await tokenizer([prefixes.query + testQuery], { padding: true })
  const queryEmbedding2 = await model(queryTokens2)
  const queryVector2: number[] = queryEmbedding2.sentence_embedding.tolist()[0]

  const dbResults = await client.execute({
    sql: `
      SELECT
        documents.content,
        vector_distance_cos(documents.embedding, vector32(?)) as distance
      FROM vector_top_k('documents_embedding_idx', vector32(?), 3) AS vt
      JOIN documents ON documents.rowid = vt.id
      ORDER BY distance ASC
    `,
    args: [JSON.stringify(queryVector2), JSON.stringify(queryVector2)],
  })

  console.log("\nDatabase ranking (Turso vector_top_k):")
  dbResults.rows.forEach((row, idx) => {
    const similarity = 1 - (row.distance as number)
    console.log(`  ${idx + 1}. [sim: ${similarity.toFixed(4)}] ${row.content}`)
  })

  // Cleanup
  client.close()
  console.log("\n✨ Experiment complete!")
}

main().catch(console.error)
