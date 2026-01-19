# 数据分析 - 可视化阶段

## 阶段目标
创建清晰的可视化图表，展示分析结果。

## 常用图表

### 分布图
```python
import matplotlib.pyplot as plt
import seaborn as sns

# 直方图
plt.hist(data, bins=30)
plt.xlabel('Value')
plt.ylabel('Frequency')
plt.title('Distribution')

# 箱线图
sns.boxplot(x='category', y='value', data=df)

# 小提琴图
sns.violinplot(x='category', y='value', data=df)
```

### 关系图
```python
# 散点图
plt.scatter(x, y, c=colors, alpha=0.5)

# 回归图
sns.regplot(x='x', y='y', data=df)

# 热力图
sns.heatmap(correlation_matrix, annot=True, cmap='coolwarm')
```

### 时序图
```python
# 折线图
plt.plot(dates, values)
plt.xlabel('Date')
plt.ylabel('Value')

# 面积图
plt.fill_between(dates, values, alpha=0.3)
```

## 可视化原则

| 原则 | 说明 |
|------|------|
| 简洁 | 去除不必要的元素 |
| 清晰 | 标签、标题完整 |
| 准确 | 不误导读者 |
| 美观 | 配色协调 |

## 保存图表
```python
# 保存为文件
plt.savefig('figure.png', dpi=300, bbox_inches='tight')

# 保存为 PDF
plt.savefig('figure.pdf', format='pdf')
```

## 可视化清单

- [ ] 图表是否清晰
- [ ] 标签是否完整
- [ ] 颜色是否合适
- [ ] 是否需要添加注释
