# 前端设计 - 响应式适配阶段

## 阶段目标
确保在各种设备上都有良好的体验。

## 响应式设计

### 断点设置
```css
/* 移动优先 */
/* 默认样式适用于移动端 */

/* 平板 */
@media (min-width: 768px) {
  /* 平板样式 */
}

/* 桌面 */
@media (min-width: 1024px) {
  /* 桌面样式 */
}

/* 大屏 */
@media (min-width: 1280px) {
  /* 大屏样式 */
}
```

### 常用断点
| 断点 | 宽度 | 设备 |
|------|------|------|
| sm | 640px | 手机横屏 |
| md | 768px | 平板 |
| lg | 1024px | 笔记本 |
| xl | 1280px | 桌面 |
| 2xl | 1536px | 大屏 |

## 适配技巧

### 弹性布局
```css
.container {
  display: flex;
  flex-wrap: wrap;
}

.item {
  flex: 1 1 300px;
}
```

### 网格布局
```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}
```

### 响应式图片
```html
<img
  srcset="small.jpg 480w, medium.jpg 800w, large.jpg 1200w"
  sizes="(max-width: 600px) 480px, (max-width: 1000px) 800px, 1200px"
  src="medium.jpg"
  alt="响应式图片"
/>
```

## 适配清单

- [ ] 移动端是否正常
- [ ] 平板端是否正常
- [ ] 桌面端是否正常
