# Dual AI Architecture with Mastra Agent and Workflow

Itinerary planning involves both exploratory conversational refinement and multi-step deterministic data extraction. We decided to split AI responsibilities between a conversational Mastra Agent with Zod-validated tool calling for interactive itinerary edits, and a dedicated Mastra Workflow for multi-stage external link and content parsing. This provides conversational fluidity and safety for user edits while ensuring reliable, reproducible extraction for external travel guides.
