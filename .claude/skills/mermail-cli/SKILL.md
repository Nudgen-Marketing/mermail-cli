```markdown
# mermail-cli Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and workflows used in the `mermail-cli` TypeScript project. You'll learn how to write code that matches the project's conventions, structure your files, manage imports/exports, and run tests using vitest. This guide is ideal for contributors aiming for consistency and efficiency in this codebase.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `emailSender.ts`, `userConfig.ts`

### Imports
- Use **relative import paths**.
  - Example:
    ```typescript
    import { sendMail } from './emailSender'
    ```

### Exports
- Use **named exports** (not default).
  - Example:
    ```typescript
    // emailSender.ts
    export function sendMail() { /* ... */ }
    ```

### Commit Messages
- Follow **conventional commit** style.
- Prefixes used: `docs`, `feat`
- Example:
  ```
  feat: add support for custom SMTP servers
  docs: update README with usage examples
  ```

## Workflows

### Running Tests
**Trigger:** When you want to verify code correctness or before submitting a pull request  
**Command:** `/run-tests`

1. Ensure you have all dependencies installed (`npm install`).
2. Run the test suite with vitest:
   ```bash
   npx vitest
   ```
3. Review the output for passing and failing tests.

### Adding a New Feature
**Trigger:** When implementing a new functionality  
**Command:** `/add-feature`

1. Create a new TypeScript file using camelCase naming.
2. Use relative imports to include any dependencies.
3. Export your functions or constants using named exports.
4. Write or update tests in a corresponding `*.test.ts` file.
5. Commit your changes using a `feat:` prefix and a concise description.

### Updating Documentation
**Trigger:** When updating or adding documentation  
**Command:** `/update-docs`

1. Edit or create markdown files as needed.
2. Commit your changes using a `docs:` prefix and a concise description.

## Testing Patterns

- Tests are written using **vitest**.
- Test files are named with the pattern `*.test.ts`.
- Example test file:
  ```typescript
  // emailSender.test.ts
  import { describe, it, expect } from 'vitest'
  import { sendMail } from './emailSender'

  describe('sendMail', () => {
    it('should send an email successfully', () => {
      expect(sendMail(/* args */)).toBe(true)
    })
  })
  ```

## Commands
| Command       | Purpose                                   |
|---------------|-------------------------------------------|
| /run-tests    | Run the vitest test suite                 |
| /add-feature  | Steps for adding a new feature            |
| /update-docs  | Steps for updating documentation          |
```
