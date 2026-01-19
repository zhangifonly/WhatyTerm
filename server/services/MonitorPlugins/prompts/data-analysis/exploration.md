# 数据分析 - 数据探索阶段

## 阶段目标
了解数据的基本特征，发现潜在问题。

## 探索性数据分析 (EDA)

### 基本统计
```python
import pandas as pd

# 数据概览
df.info()
df.describe()
df.shape

# 缺失值
df.isnull().sum()
df.isnull().sum() / len(df) * 100

# 数据类型
df.dtypes
```

### 分布分析
```python
# 数值型变量
df['column'].hist()
df['column'].describe()

# 类别型变量
df['column'].value_counts()
df['column'].value_counts(normalize=True)
```

### 相关性分析
```python
# 相关系数矩阵
df.corr()

# 热力图
import seaborn as sns
sns.heatmap(df.corr(), annot=True)
```

## 数据质量检查

| 检查项 | 方法 | 处理方式 |
|--------|------|----------|
| 缺失值 | isnull() | 填充/删除 |
| 重复值 | duplicated() | 去重 |
| 异常值 | IQR/Z-score | 处理/标记 |
| 数据类型 | dtypes | 转换 |

## 探索清单

- [ ] 数据规模是否合适
- [ ] 是否有缺失值
- [ ] 数据分布是否正常
- [ ] 是否有异常值
