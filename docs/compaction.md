State of the art for fast conversational agents is a mix of: (1) structured, lossy compression of history (not plain “summarize into prose”), (2) retrieval-based context instead of full logs, and (3) dedicated prompt‑compression models or passes that run cheaper/faster than your main model.[1][2][3]

## Core patterns that actually work

- **Rolling / layered summaries instead of raw history**  
  Use a rolling compression pipeline: recent turns kept verbatim, mid‑range turns collapsed into structured bullet‑point summaries, and very old turns turned into a tiny “conversation brief” (e.g. a few hundred tokens).[4][5]
  Empirically, non‑reasoning models used for dialogue summarization tend to be more concise and reliable than chain‑of‑thought variants, which often get verbose and inconsistent for this task.[6]

- **Semantic memory + retrieval instead of long logs**  
  Embed each user and assistant turn, store in a vector DB, and on each request fetch only the k most relevant past snippets, then compress them again to short, structured notes before injecting into the prompt.[1]
  This “semantic compression with embeddings” dramatically cuts tokens while preserving what’s actually needed for the current query, especially in long‑running chats.[1]

- **Structured prompt compression (not just “shorter text”)**  
  Recent prompt‑compression work focuses on converting verbose prompts into compact, machine‑oriented structures: key–value fact lists, normalized entities, extracted constraints, and IDs pointing to external state.[2][3]
  This allows you to keep semantic content with fewer tokens and is usually done by a small, fast model or a dedicated compression pass before calling your main model.[3]

## Aggressive token‑budget strategies

- **Hard context budget with triggers**  
  Maintain an explicit token budget per call (e.g. 2–4k total) and trigger compaction when either total tokens, number of turns, or user turns exceed a threshold.[7]
  Headroom is important: compaction should fire before you hit the hard model limit so the model still has “working space” for its answer.[7]

- **Multi-tier representation of the same info**  
  For each important fact, keep: (a) a canonical, hyper‑compressed representation (one or two lines of schema‑like text), and (b) a pointer (ID) to full detail in your DB or object storage.[1]
  At inference time you usually send only the compressed version; only in rare “deep dive” situations do you temporarily expand specific facts back into richer text.

- **Minimal structured history instead of natural language**  
  Once a turn is “old,” re‑encode it as a schema like:  
  `user_goal=..., constraints=[...], decisions=[...], unresolved=[...]` instead of prose.[2][3]
  This both speeds tokenization and drastically reduces length while staying semantically precise.

## Speed vs. quality trade‑offs

- **Use a cheaper model for compression**  
  Many production systems call a very fast model (e.g. a “flash” or “haiku”‑style model) to maintain summaries and memory, and reserve the stronger but slower model for user‑visible replies.[7][1]
  For aggressive reduction, shorter, non‑CoT prompts for the summarizer tend to yield tighter summaries and better latency than asking it to “think step by step,” which increases verbosity.[6]

- **Prefer retrieval + tiny summaries over giant long‑context calls**  
  With modern long‑context windows, it is tempting to just keep feeding more tokens, but long contexts significantly increase latency and KV‑cache memory even if they fit.[8][1]
  Systems that combine retrieval with structured, compact summaries usually achieve comparable answer quality at a fraction of tokens and with lower serving cost.[2][1]

## Concrete architecture you might use

- Keep last N (e.g. 4–8) turns verbatim.  
- Maintain a rolling, structured summary of everything before that, updated by a fast model whenever you cross a token/turn threshold.[4][7]
- Store all turns in a vector store; on each query, retrieve k relevant chunks, compress them into a short fact list, and merge with: base system prompt + user message + recent verbatim turns + rolling summary.[5][1]
- Optionally, add a prompt‑compression step right before calling the main model to re‑phrase the whole assembled context into an ultra‑compact, schema‑like form using a small model.[3][2]

If you share your target model (e.g. “Gemini Flash”, “Claude Haiku”, “local Qwen 7B”) and rough latency budget, a concrete token‑budget and compaction policy can be sketched for your stack.

[1](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots/)
[2](https://www.sandgarden.com/learn/prompt-compression)
[3](https://www.freecodecamp.org/news/how-to-compress-your-prompts-and-reduce-llm-costs/)
[4](https://betterprogramming.pub/easy-chatgpt-chatbot-with-memory-compression-389166064947)
[5](https://blog.mycal.net/infinite-ai-chat-windows/)
[6](https://arxiv.org/abs/2507.02145)
[7](https://forgecode.dev/docs/context-compaction/)
[8](https://arxiv.org/html/2511.05313v1)
[9](https://www.siliconflow.com/articles/en/best-open-source-llms-for-summarization)
[10](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025)
[11](https://www.deepchecks.com/evaluate-state-of-the-art-llm-models/)
[12](https://proffiz.com/large-language-models-in-2025/)
[13](https://agentic-patterns.com/patterns/context-window-anxiety-management/)
[14](https://aclanthology.org/2025.acl-industry.35.pdf)
[15](https://github.com/cline/cline/discussions/2979)
[16](https://assemblyai.com/blog/summarize-meetings-llms-python)
[17](https://hatchworks.com/blog/gen-ai/large-language-models-guide/)
[18](https://codingscape.com/blog/most-powerful-llms-large-language-models)
[19](https://www.emergentmind.com/topics/visual-token-compression)
[20](https://arxiv.org/html/2507.20198v3)
