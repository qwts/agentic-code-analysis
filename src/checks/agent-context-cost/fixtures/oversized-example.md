# Commit messages

Commit messages follow Conventional Commits: a type prefix (`feat`, `fix`,
`docs`, `refactor`, `test`, `chore`), a scope in parentheses when one
applies, and an imperative subject line under 72 characters. Breaking
changes add `!` after the type and a `BREAKING CHANGE:` footer.

For example, suppose you have just fixed a bug in the checkout flow where
the discount code field rejected valid codes containing hyphens. You would
first review your staged changes to confirm they only touch the validation
logic, and then you would write a commit message like the following:

```text
fix(checkout): accept hyphenated discount codes

The discount input validated against [A-Z0-9]+ only, rejecting
codes like SUMMER-2024 that the marketing site hands out. Widen
the pattern and normalize case before lookup.

Fixes #831.
```

Suppose instead you were adding a brand-new feature, such as letting users
export their order history as a CSV file. In that case the type would be
`feat`, the scope would name the area of the application, and the body
would explain the motivation and the shape of the change, like so:

```text
feat(orders): export order history as CSV

Adds an Export button to the order-history page and a streaming
/api/orders/export endpoint. Large histories stream in 500-row
chunks so the worker never buffers the full result set.

Closes #712.
```

And if you were making a change that only touches documentation — say,
correcting an outdated setup step in the README — the type would be `docs`
and no scope is necessary, as in this final example:

```text
docs: correct Node version in setup instructions

The README said Node 16; CI and production run Node 20.
```
