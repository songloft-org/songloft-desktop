import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    // .Trash-*：GNOME 回收站在工作区根下落的那一份（把文件删进回收站时出现），
    // 是环境产物不是仓库内容 —— 不忽略的话 eslint . 会拿几千条垃圾报错把 lint 打挂
    ignores: ['out/**', 'release/**', 'node_modules/**', 'build/**', 'coverage/**', '.Trash-*/**']
  },

  // ★ 核心规则必须显式引入：typescript-eslint 的 recommended 不含核心规则，
  //   少了它 no-unreachable / no-dupe-keys / no-control-regex 之类全是关着的。
  //   顺序上排在 tseslint 之前（tseslint 会关掉被自己取代的那几条核心规则）。
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  {
    // ★ 自定义规则一律写在 rules 下面，平铺到 config 层会直接报
    //   Config (unnamed): Unexpected key "..." found。
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // ★ 默认没有豁免，_unused 这种写法照样报错。
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="eval"]',
          message: '禁止 eval。'
        }
      ]
    }
  },

  {
    // 主进程与构建脚本跑在 Node 里，console / process 是它们的正常接口。
    // 这里手动声明 globals，不引 globals 包 —— 只用到这三个，不值得多一个依赖。
    files: ['src/main/**/*.ts', 'scripts/**/*', '*.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly'
      }
    },
    rules: { 'no-console': 'off' }
  },

  {
    // E2E 脚本（mock 后端 + CDP 驱动）是 Node ESM，用到的全局比主进程多：
    // WebSocket/fetch 驱动 CDP，Buffer 处理截图字节，Timer 做轮询等待。
    files: ['scripts/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocket: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        structuredClone: 'readonly'
      }
    }
  },

  {
    // 渲染层禁止直接碰 Node / Electron 远程模块：能力只能经 preload 白名单进。
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: '渲染层不得直接 import electron，请走 window.songloft（preload 白名单）。'
            },
            { name: 'node:fs', message: '渲染层不得访问文件系统，请走 window.songloft。' },
            { name: 'node:child_process', message: '渲染层不得启动进程。' }
          ]
        }
      ]
    }
  }
)
