/**
 * Packaging. The app is this directory — the main process and the tray images, in the asar archive.
 * The server is the checkout around it, copied beside the app's resources as plain files (see
 * server-dir.js for why), and only what the server runs: no tests, no UI sources, no private notes.
 *
 * Signing and notarisation are read from the environment, so an unsigned local build needs nothing:
 *  - macOS signs with a "Developer ID Application" identity from the keychain, or CSC_LINK and
 *    CSC_KEY_PASSWORD; it notarises when APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are set.
 *  - Windows signs through Azure Trusted Signing when AZURE_SIGNING_* is set (below), or with an
 *    exportable certificate in WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD.
 * `CSC_IDENTITY_AUTO_DISCOVERY=false` forces an unsigned build on a Mac that has an identity.
 *
 * Publishing happens only when asked (`--publish always`, as the release workflow does).
 */
import fs from 'node:fs';

const serverPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Azure Trusted Signing, when its account is configured. Code-signing certificates are no longer
 * issued as files that could go in WIN_CSC_LINK, so a cloud signer is how a Windows build gets
 * signed on a CI runner. The credentials — AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET —
 * are read by the signing module itself. `publisherName` is also what an installed app checks an
 * update's signature against.
 */
const azureSignOptions = process.env.AZURE_SIGNING_ENDPOINT
  ? {
      endpoint: process.env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGNING_PROFILE,
      publisherName: process.env.AZURE_SIGNING_PUBLISHER,
    }
  : null;

/** Relative to the checkout. */
const SERVER_FILES = ['package.json', 'LICENSE', '*.js', 'http/**', 'platform/**', 'postgres/**', 'ui/dist/**'];

/**
 * macOS asks before a process reads these folders, and asks on behalf of the app: the dev servers
 * Paddock spawns are its children. Repositories live in all of them.
 */
const FOLDER_ACCESS_REASON =
  'Paddock runs the development servers you register, and they read the repositories you keep here.';

export default {
  appId: 'io.github.igbaryya.paddock',
  productName: 'Paddock',
  // One version for the product: the server's.
  extraMetadata: { version: serverPackage.version },
  directories: { output: 'dist', buildResources: 'build' },
  files: ['package.json', '*.js', '!electron-builder.config.js', 'assets/**'],
  // node_modules is its own entry because electron-builder drops a node_modules at the root of any
  // source. The root package has no devDependencies, so what is installed there is the runtime.
  extraResources: [
    { from: '..', to: 'server', filter: SERVER_FILES },
    { from: '../node_modules', to: 'server/node_modules' },
  ],
  icon: 'icon.png',
  // The update feed an installed app reads. Builds upload into a draft release, and the feed only
  // sees published ones, so nothing reaches users until the draft is published by hand.
  publish: { provider: 'github', owner: 'igbaryya', repo: 'paddock', releaseType: 'draft' },
  electronFuses: {
    // ELECTRON_RUN_AS_NODE turns a signed app into a node binary that inherits its privacy grants.
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    // Flipping a fuse breaks the ad-hoc signature an unsigned Apple silicon build cannot launch
    // without; a real identity signs over it afterwards.
    resetAdHocDarwinSignature: true,
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSDesktopFolderUsageDescription: FOLDER_ACCESS_REASON,
      NSDocumentsFolderUsageDescription: FOLDER_ACCESS_REASON,
      NSDownloadsFolderUsageDescription: FOLDER_ACCESS_REASON,
      NSRemovableVolumesUsageDescription: FOLDER_ACCESS_REASON,
      NSNetworkVolumesUsageDescription: FOLDER_ACCESS_REASON,
    },
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'build/icon-win.png',
    azureSignOptions,
  },
  // Per-user, into a fixed directory: the Run key entry names the executable's path.
  // No spaces in the name: GitHub replaces them on upload, and latest.yml names the uploaded file.
  nsis: { oneClick: true, perMachine: false, artifactName: '${productName}-Setup-${version}.${ext}' },
};
