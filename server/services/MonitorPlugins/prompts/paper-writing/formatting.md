# 论文写作 - 格式排版阶段

## 阶段目标
按照目标期刊/会议的要求进行格式排版。

## 格式要素

### 1. 页面设置
| 要素 | 常见要求 |
|------|---------|
| 纸张 | A4 或 Letter |
| 页边距 | 2.5cm 或 1 inch |
| 行距 | 双倍行距 |
| 字体 | Times New Roman 12pt |
| 对齐 | 两端对齐 |

### 2. 标题格式
```markdown
# 一级标题（居中，加粗）
## 二级标题（左对齐，加粗）
### 三级标题（左对齐，斜体）
```

### 3. 引用格式

#### APA 格式（第7版）
```
# 期刊文章
Author, A. A., & Author, B. B. (Year). Title of article.
Title of Periodical, volume(issue), page–page. https://doi.org/xxxxx

# 书籍
Author, A. A. (Year). Title of work: Capital letter also for subtitle.
Publisher.

# 网页
Author, A. A. (Year, Month Day). Title of page. Site Name. URL
```

#### MLA 格式
```
# 期刊文章
Author. "Title of Article." Title of Journal, vol. #, no. #,
Year, pp. #-#.

# 书籍
Author. Title of Book. Publisher, Year.
```

### 4. 图表格式

#### 图片
```markdown
Figure 1
[图片]
Note. 图片说明文字。
```

#### 表格
```markdown
Table 1
表格标题

| 列1 | 列2 | 列3 |
|-----|-----|-----|
| 数据 | 数据 | 数据 |

Note. 表格说明。
```

## 常见期刊格式

### IEEE 格式
- 双栏排版
- 10pt 字体
- 参考文献用数字标注 [1]

### ACM 格式
- 双栏排版
- 9pt 字体
- 参考文献用数字标注

### Nature 格式
- 单栏排版
- 方法部分放在最后
- 参考文献用数字标注

## 格式检查工具

### LaTeX
```latex
\documentclass[12pt]{article}
\usepackage{times}
\usepackage{geometry}
\geometry{a4paper, margin=2.5cm}
\usepackage{setspace}
\doublespacing
```

### Word
- 使用样式功能
- 使用引用管理器
- 使用目录功能

## 检查清单

- [ ] 页面设置是否符合要求
- [ ] 字体和字号是否正确
- [ ] 行距是否正确
- [ ] 标题格式是否一致
- [ ] 引用格式是否规范
- [ ] 图表格式是否正确
- [ ] 页码是否正确
- [ ] 目录是否更新
