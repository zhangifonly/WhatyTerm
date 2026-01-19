# 数据分析 - 模型训练阶段

## 阶段目标
训练模型，监控训练过程，防止过拟合。

## 训练流程

### 数据划分
```python
from sklearn.model_selection import train_test_split

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)

# 进一步划分验证集
X_train, X_val, y_train, y_val = train_test_split(
    X_train, y_train, test_size=0.2, random_state=42
)
```

### 训练循环
```python
for epoch in range(num_epochs):
    model.train()
    for batch in train_loader:
        optimizer.zero_grad()
        outputs = model(batch)
        loss = criterion(outputs, targets)
        loss.backward()
        optimizer.step()

    # 验证
    model.eval()
    val_loss = evaluate(model, val_loader)
    print(f'Epoch {epoch}: train_loss={loss:.4f}, val_loss={val_loss:.4f}')
```

## 训练监控

### 损失曲线
- 训练损失应持续下降
- 验证损失应与训练损失接近
- 验证损失上升表示过拟合

### 早停策略
```python
best_val_loss = float('inf')
patience = 10
counter = 0

for epoch in range(num_epochs):
    val_loss = train_epoch()
    if val_loss < best_val_loss:
        best_val_loss = val_loss
        counter = 0
        save_model()
    else:
        counter += 1
        if counter >= patience:
            print('Early stopping')
            break
```

## 训练清单

- [ ] 损失是否下降
- [ ] 是否有过拟合
- [ ] 训练是否稳定
- [ ] 是否需要早停
