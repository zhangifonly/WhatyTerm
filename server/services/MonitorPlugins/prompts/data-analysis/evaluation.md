# 数据分析 - 结果评估阶段

## 阶段目标
评估模型性能，分析结果，确定改进方向。

## 评估指标

### 分类指标
```python
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, roc_auc_score, confusion_matrix
)

# 准确率
accuracy = accuracy_score(y_true, y_pred)

# 精确率、召回率、F1
precision = precision_score(y_true, y_pred)
recall = recall_score(y_true, y_pred)
f1 = f1_score(y_true, y_pred)

# AUC
auc = roc_auc_score(y_true, y_prob)

# 混淆矩阵
cm = confusion_matrix(y_true, y_pred)
```

### 回归指标
```python
from sklearn.metrics import (
    mean_squared_error, mean_absolute_error, r2_score
)

# MSE / RMSE
mse = mean_squared_error(y_true, y_pred)
rmse = np.sqrt(mse)

# MAE
mae = mean_absolute_error(y_true, y_pred)

# R²
r2 = r2_score(y_true, y_pred)
```

## 结果分析

### 错误分析
```python
# 找出预测错误的样本
errors = X_test[y_pred != y_test]

# 分析错误模式
error_analysis = pd.DataFrame({
    'true': y_test[y_pred != y_test],
    'pred': y_pred[y_pred != y_test]
})
```

### 特征重要性
```python
# 树模型
importances = model.feature_importances_

# 排序
indices = np.argsort(importances)[::-1]
for i in indices:
    print(f'{feature_names[i]}: {importances[i]:.4f}')
```

## 评估清单

- [ ] 指标是否达标
- [ ] 是否有偏差
- [ ] 泛化能力如何
- [ ] 是否需要调优
