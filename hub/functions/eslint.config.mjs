export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        exports: "writable",
        process: "readonly",
        require: "readonly",
      },
    },
    rules: {
      "max-len": ["error", {code: 100, ignoreStrings: true}],
      "object-curly-spacing": ["error", "never"],
      "require-jsdoc": "off",
    },
  },
];
