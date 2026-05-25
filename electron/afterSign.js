// electron-builder afterSign hook.
// Re-runs codesign --deep --force --sign - over the whole .app so the embedded
// Python sidecar binary shares the ad-hoc signature instead of being unsigned,
// which is what flips macOS Gatekeeper from "unknown developer" to "damaged".

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`[afterSign] deep ad-hoc signing ${appPath}`);
  execFileSync(
    'codesign',
    ['--deep', '--force', '--sign', '-', appPath],
    { stdio: 'inherit' },
  );
};
