Record a decision in the current project's DECISIONS.md.

Usage: /decide [description of the decision]

Instructions:
1. Identify the current project root (the nearest directory with a CLAUDE.md)
2. Dispatch the @rh-docs-knowledge agent with the following context:
   - The decision description provided by the user: $ARGUMENTS
   - The current conversation context (what was discussed, alternatives considered, evidence)
   - The project path for locating/creating DECISIONS.md
3. The agent will:
   - Check for an existing DECISIONS.md at the project root
   - Find the highest existing decision number and increment
   - Add a row to the Quick Reference table
   - If the decision involved 2+ alternatives with evidence, add a Detail Entry
   - If no DECISIONS.md exists, create one with the hybrid format
