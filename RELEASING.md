# Publishing the JavaScript SDK

The `Validate and publish npm` GitHub Actions workflow publishes stable GitHub
releases to npm through OIDC. No npm access token or npm login is needed in CI.
It requires a matching Trusted Publisher configured on npm for `@plexivo/client`:

- GitHub organization: `plexivo`
- Repository: `plexivo-javascript-sdk`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Permission: direct publishing (`npm publish`)

## Release from an authorized GitHub account or agent

1. Make and review the SDK changes. Run `npm test` and `npm run pack:check`.
2. Set a new, previously unpublished stable version in `package.json`, update the
   release notes, and commit and push the changes to `main`.
3. Create a tag matching the version exactly (for example `v0.1.1`) on that commit.
4. Publish a GitHub Release for the tag. This triggers validation and publishing.
5. Wait for both workflow jobs to succeed, then verify the version on npm and
   install it in a clean project before reporting success.

The workflow rejects mismatched tags, prereleases, and commits outside `main`.
Running it manually from the Actions tab only validates; it never publishes.
Draft releases, ordinary pushes, and pull requests do not publish either.

Publishing an existing version again fails: npm versions are immutable. To undo
a code change, revert the source and publish a new version rather than attempting
to overwrite an existing package. Account recovery codes are not publish tokens.

Keep GitHub release and workflow-edit access limited to authorized maintainers.
Do not put npm credentials in this repository or in workflow secrets.
