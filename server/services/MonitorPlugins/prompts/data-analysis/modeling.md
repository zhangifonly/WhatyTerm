# 数据分析 - 模型构建阶段

## 阶段目标
选择合适的模型架构，设置超参数。

## 模型选择

### 监督学习
| 任务类型 | 常用模型 |
|----------|----------|
| 分类 | 逻辑回归、决策树、随机森林、XGBoost、神经网络 |
| 回归 | 线性回归、岭回归、Lasso、随机森林、XGBoost |

### 无监督学习
| 任务类型 | 常用模型 |
|----------|----------|
| 聚类 | K-Means、DBSCAN、层次聚类 |
| 降维 | PCA、t-SNE、UMAP |

### 深度学习
```python
import torch.nn as nn

class Model(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(input_size, hidden_size)
        self.fc2 = nn.Linear(hidden_size, output_size)
        self.relu = nn.ReLU()
        self.dropout = nn.Dropout(0.5)

    def forward(self, x):
        x = self.relu(self.fc1(x))
        x = self.dropout(x)
        x = self.fc2(x)
        return x
```

## 超参数设置

### 常见超参数
| 参数 | 说明 | 典型值 |
|------|------|--------|
| 学习率 | 梯度下降步长 | 0.001-0.1 |
| 批大小 | 每批样本数 | 32-256 |
| 正则化 | 防止过拟合 | L1/L2 |
| Dropout | 随机丢弃 | 0.2-0.5 |

## 建模清单

- [ ] 模型结构是否合理
- [ ] 参数量是否适中
- [ ] 是否有过拟合风险
- [ ] 是否选择合适的损失函数
