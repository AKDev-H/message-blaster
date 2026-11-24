import babelParser from '@babel/eslint-parser';
import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig(
    {
        files: ['eslint.config.mjs', 'cypress.config.mjs', '{src,tests}/**/*.ts', 'web/**/*.mjs', 'cypress/**/*.js'],
        extends: [eslint.configs.recommended],
        plugins: { '@stylistic': stylistic },
        rules: {
            '@stylistic/indent': ['error', 4],
            '@stylistic/indent-binary-ops': ['error', 4],
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/eol-last': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
            '@stylistic/semi': ['error', 'always'],
        },
    },
    {
        files: ['web/**/*.mjs'],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['cypress.config.mjs'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['cypress/**/*.js'],
        languageOptions: {
            globals: { ...globals.browser, ...globals.mocha, cy: 'readonly', Cypress: 'readonly', expect: 'readonly' },
        },
    },
    {
        files: ['{src,tests}/**/*.ts'],
        languageOptions: {
            parser: babelParser,
            parserOptions: {
                requireConfigFile: false,
                babelOptions: {
                    babelrc: false,
                    configFile: false,
                    parserOpts: { plugins: ['typescript'] },
                },
            },
        },
        rules: {
            'no-undef': 'off',
            'no-redeclare': 'off',
            'no-unused-vars': 'off',
        },
    },
);
