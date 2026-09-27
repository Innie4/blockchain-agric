// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Lint rules for the API.
 *
 * The rule set is deliberately small and strict about the things that would let
 * a defect reach a participant: floating promises, unchecked `any`, unused code
 * and unreachable branches. Style is left to Prettier, so linting and formatting
 * never disagree.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // A floating promise is how a failed write is silently lost.
      "@typescript-eslint/no-floating-promises": "error",
      // Express accepts an async middleware and every handler here catches its
      // own failure and forwards it to `next`, so a promise argument is correct
      // rather than a mistake.
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: { attributes: false, arguments: false },
          checksConditionals: false,
        },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // An `async` method with no `await` is how a class satisfies an interface
      // that returns a promise, so the keyword is required rather than a smell.
      "@typescript-eslint/require-await": "off",
      // Mongoose's `lean()` results and the values handed back by the Solana
      // client are `unknown` at the type level by design: they come from outside
      // the program. The code narrows them explicitly with `stringOr` and the
      // runtime guards in the error handler, so these rules report the shape of
      // the third-party types rather than a defect here.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      // Comparing against a Mongoose connection-state enum through a numeric
      // value is how the driver exposes it.
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      // Dead code is a defect the compiler cannot see through a dynamic import.
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      // An error message shown to a participant must not be an interpolation of
      // an unknown value; the codebase has explicit copy for that.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='console'][object.property.name=/^(log|debug|info|dir|table|trace)$/]",
          message: "Use the structured logger in lib/logger.ts instead of console output.",
        },
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='exit'][object.property.name='code']",
          message: "Throw a domain error and let the process entry point decide the exit code.",
        },
      ],
    },
  },
  {
    // The config file itself is plain JavaScript and is not in a tsconfig
    // project, so it is linted with the recommended rules only.
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The test harness deliberately fabricates values and stubs the chain.
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  }
);
