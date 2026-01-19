# 前端设计 - 样式调整阶段

## 阶段目标
完善视觉样式，确保设计一致性。

## 设计系统

### 颜色系统
```css
:root {
  /* 主色 */
  --primary: #3b82f6;
  --primary-dark: #2563eb;
  --primary-light: #60a5fa;

  /* 中性色 */
  --gray-100: #f3f4f6;
  --gray-500: #6b7280;
  --gray-900: #111827;

  /* 语义色 */
  --success: #10b981;
  --warning: #f59e0b;
  --error: #ef4444;
}
```

### 字体系统
```css
:root {
  /* 字体族 */
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'Fira Code', monospace;

  /* 字号 */
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.25rem;
}
```

### 间距系统
```css
:root {
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
}
```

## 样式技巧

### 阴影
```css
.card {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.card:hover {
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}
```

### 过渡动画
```css
.button {
  transition: all 0.2s ease;
}
```

## 调整清单

- [ ] 颜色是否协调
- [ ] 间距是否一致
- [ ] 字体是否合适
