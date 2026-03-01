-- Vector indexes for semantic search
CREATE INDEX IF NOT EXISTS session_memory_entries_embedding_idx
ON session_memory_entries(libsql_vector_idx(embedding));

CREATE INDEX IF NOT EXISTS doc_chunks_embedding_idx
ON doc_chunks(libsql_vector_idx(embedding));

CREATE INDEX IF NOT EXISTS code_modules_embedding_idx
ON code_modules(libsql_vector_idx(embedding));
