# Project instructions

This project is a web application written in TypeScript. The TypeScript
source code is located in the `src/` directory, and the tests can be found
in the `tests/` directory. Configuration files are in the root of the
repository.

## Getting started

To install the dependencies, run `npm install`. To run the test suite, you
can use `npm test`. To build the project, run `npm run build`. To start the
development server, use `npm run dev`. All of these scripts are defined in
the `scripts` section of `package.json`, which you can consult for the full
list of available commands.

## Code style

Generally speaking, when it is possible and reasonable to do so, please try
to follow the existing code style that you observe in the files you are
editing. It is usually a good idea to keep functions reasonably small, and
where appropriate, to add comments where they might be helpful for other
people reading the code later. We would prefer that, whenever it makes
sense in context, you use meaningful and descriptive variable names.

## Project structure

The `src/` directory contains the source code. Inside it, the
`src/routes/` directory contains the route handlers, the `src/models/`
directory contains the data models, and the `src/utils/` directory contains
utility functions that are shared across the codebase. The `tests/`
directory mirrors the structure of the `src/` directory. Static assets such
as images and stylesheets live in the `public/` directory.

## Dependencies

This project uses Express for the web server and Vitest for running the
tests. The complete and authoritative list of dependencies, together with
their exact version numbers, is maintained in `package.json`.
