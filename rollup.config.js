export default {
  input: 'dist/esm/index.js',
  output: [
    {
      file: 'dist/plugin.cjs.js',
      format: 'cjs',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: 'dist/plugin.js',
      format: 'iife',
      name: 'capacitorMsalEntraPlugin',
      globals: {
        '@capacitor/core': 'capacitorExports',
        '@azure/msal-browser': 'msal',
      },
      sourcemap: true,
      inlineDynamicImports: true,
    },
  ],
  external: ['@capacitor/core', '@azure/msal-browser'],
};
