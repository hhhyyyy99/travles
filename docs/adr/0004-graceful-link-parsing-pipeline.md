# Graceful External Link and Content Parsing Pipeline

External travel content platforms (such as Xiaohongshu) employ aggressive anti-scraping and authentication gates that reliably break headless server crawlers. We decided to implement a dual-mode parser that attempts direct URL extraction but gracefully falls back to prompt travelers to paste copied text into the same workflow. This avoids introducing brittle third-party crawling microservices while ensuring high extraction success and complete Zod schema conformance.
