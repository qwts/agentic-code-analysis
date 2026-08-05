# Style rules

- Always use single quotes for strings in TypeScript files, never double
  quotes, except where the string itself contains a single quote.
- Keep every line under 100 characters.
- Use two-space indentation everywhere; tabs are not allowed.
- Always add trailing commas in multi-line arrays and object literals.
- Never leave `console.log` statements in committed code.
- Every file must end with exactly one trailing newline.
- Imports must be sorted alphabetically within their group, with external
  packages before internal modules.
- Run `npm run lint` and fix all reported warnings before committing.
- Never commit directly to `main`; every change goes through a branch.
