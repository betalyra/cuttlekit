-- Vector index for semantic search on session_memory_entries
CREATE INDEX IF NOT EXISTS session_memory_entries_embedding_idx
ON session_memory_entries(libsql_vector_idx(embedding));
