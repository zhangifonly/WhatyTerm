# 科学研究 - 结果验证阶段

## 阶段目标
验证研究结果的可靠性和可重复性。

## 统计验证

### 显著性检验
```python
from scipy import stats

# p 值解释
# p < 0.05: 统计显著
# p < 0.01: 高度显著
# p < 0.001: 极显著

# 多重检验校正
from statsmodels.stats.multitest import multipletests
rejected, p_adjusted, _, _ = multipletests(p_values, method='fdr_bh')
```

### 效应量
```python
# Cohen's d
def cohens_d(group1, group2):
    n1, n2 = len(group1), len(group2)
    var1, var2 = np.var(group1), np.var(group2)
    pooled_std = np.sqrt(((n1-1)*var1 + (n2-1)*var2) / (n1+n2-2))
    return (np.mean(group1) - np.mean(group2)) / pooled_std

# 效应量解释
# 0.2: 小效应
# 0.5: 中等效应
# 0.8: 大效应
```

## 可重复性验证

### 交叉验证
```python
from sklearn.model_selection import cross_val_score

scores = cross_val_score(model, X, y, cv=5)
print(f'Mean: {scores.mean():.3f}, Std: {scores.std():.3f}')
```

### 独立验证
- 使用独立数据集验证
- 与已发表结果对比
- 请同行复现

## 验证清单

- [ ] 结果是否可重复
- [ ] 统计显著性如何
- [ ] 是否有偏差
