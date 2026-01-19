# 科学研究 - 数据采集阶段

## 阶段目标
收集高质量的实验数据。

## 数据来源

### 公开数据库
| 领域 | 数据库 | 说明 |
|------|--------|------|
| 基因组 | NCBI GEO | 基因表达数据 |
| 蛋白质 | UniProt | 蛋白质序列 |
| 化学 | ChEMBL | 化合物数据 |
| 临床 | ClinicalTrials | 临床试验 |

### 数据下载
```python
# 使用 API
import requests
response = requests.get(api_url)
data = response.json()

# 使用专用库
from Bio import Entrez
Entrez.email = "your@email.com"
handle = Entrez.efetch(db="nucleotide", id="NM_001234")
```

## 数据质量控制

### 质量检查
- 数据完整性
- 数据一致性
- 数据准确性
- 数据时效性

### 数据清洗
```python
# 检查缺失值
df.isnull().sum()

# 检查重复值
df.duplicated().sum()

# 检查异常值
df.describe()
```

## 采集清单

- [ ] 数据来源是否可靠
- [ ] 数据格式是否正确
- [ ] 是否有缺失值
