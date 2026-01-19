# 前端设计 - 组件开发阶段

## 阶段目标
开发可复用的 UI 组件。

## 组件设计原则

### 单一职责
```jsx
// 好的设计
<Button>提交</Button>
<Input placeholder="请输入" />

// 不好的设计
<ButtonWithInput />  // 职责不清
```

### 可配置性
```jsx
// 通过 props 配置
<Button
  variant="primary"
  size="large"
  disabled={false}
  onClick={handleClick}
>
  提交
</Button>
```

### 组合优于继承
```jsx
// 组合
<Card>
  <CardHeader>标题</CardHeader>
  <CardBody>内容</CardBody>
  <CardFooter>操作</CardFooter>
</Card>
```

## 组件示例

### 按钮组件
```jsx
const Button = ({ variant, size, children, ...props }) => {
  const classes = `btn btn-${variant} btn-${size}`;
  return (
    <button className={classes} {...props}>
      {children}
    </button>
  );
};

Button.defaultProps = {
  variant: 'primary',
  size: 'medium'
};
```

### 输入组件
```jsx
const Input = ({ label, error, ...props }) => (
  <div className="input-wrapper">
    {label && <label>{label}</label>}
    <input {...props} />
    {error && <span className="error">{error}</span>}
  </div>
);
```

## 开发清单

- [ ] 组件是否可复用
- [ ] 接口是否清晰
- [ ] 是否有适当的 props
