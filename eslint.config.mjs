import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'resources/**',
      'node_modules/**',
      'src/preload/**',
      'src/renderer/**',
      'scripts/**',
      'eslint.config.mjs',
    ],
  },
  ...tseslint.configs.recommended,
)
