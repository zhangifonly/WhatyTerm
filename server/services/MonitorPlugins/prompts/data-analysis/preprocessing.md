# 数据分析 - 数据预处理阶段

## 阶段目标
清洗数据，进行特征工程，准备建模数据。

## 数据清洗

### 缺失值处理
```python
# 删除缺失值
df.dropna()
df.dropna(subset=['column'])

# 填充缺失值
df.fillna(0)
df.fillna(df.mean())
df.fillna(method='ffill')  # 前向填充
df.fillna(method='bfill')  # 后向填充
```

### 异常值处理
```python
# IQR 方法
Q1 = df['column'].quantile(0.25)
Q3 = df['column'].quantile(0.75)
IQR = Q3 - Q1
lower = Q1 - 1.5 * IQR
upper = Q3 + 1.5 * IQR

# 过滤异常值
df = df[(df['column'] >= lower) & (df['column'] <= upper)]
```

## 特征工程

### 特征编码
```python
# 标签编码
from sklearn.preprocessing import LabelEncoder
le = LabelEncoder()
df['encoded'] = le.fit_transform(df['category'])

# 独热编码
pd.get_dummies(df, columns=['category'])
```

### 特征缩放
```python
from sklearn.preprocessing import StandardScaler, MinMaxScaler

# 标准化
scaler = StandardScaler()
df_scaled = scaler.fit_transform(df)

# 归一化
scaler = MinMaxScaler()
df_normalized = scaler.fit_transform(df)
```

## 预处理清单

- [ ] 缺失值是否处理
- [ ] 数据类型是否正确
- [ ] 特征是否标准化
- [ ] 是否有数据泄露
