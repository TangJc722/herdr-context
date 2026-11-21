# Notes for working on this repository

- The README exists in two languages: `README.md` (English) and `README.zh-CN.md`
  (Simplified Chinese). Any change to one must be made to the other in the same
  commit, with the same sections in the same order. Command output examples stay
  in English in both (the CLI prints English).
- Commits use the owner's GitHub no-reply identity (set in this repo's
  `.git/config`); do not put a personal email address in commits.
- Run `npm test` before committing. Test fixtures are synthetic: never commit
  real agent session logs, which contain conversation content.
