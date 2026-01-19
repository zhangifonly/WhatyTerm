# App 开发 - 构建打包阶段

## 阶段目标
构建生产版本，验证构建产物。

## 构建流程

### 前端构建
```bash
# React/Vue/Next.js
npm run build

# 检查构建产物
ls -la dist/
du -sh dist/
```

### 后端构建
```bash
# Node.js
npm run build

# Go
go build -o app

# Rust
cargo build --release
```

## 构建优化

### 代码分割
```javascript
// 动态导入
const Component = lazy(() => import('./Component'));

// 路由级分割
const routes = [
  { path: '/', component: () => import('./Home') }
];
```

### 资源优化
| 优化项 | 方法 |
|--------|------|
| 图片 | 压缩、WebP、懒加载 |
| JS | 压缩、Tree Shaking |
| CSS | 压缩、PurgeCSS |
| 字体 | 子集化、预加载 |

### 缓存策略
```
# 静态资源
Cache-Control: max-age=31536000

# HTML
Cache-Control: no-cache
```

## 构建清单

- [ ] 构建成功
- [ ] 产物大小合理
- [ ] 无警告需处理
- [ ] 构建时间正常
