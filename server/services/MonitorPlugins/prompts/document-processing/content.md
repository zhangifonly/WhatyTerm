# 文档处理 - 内容生成阶段

## 阶段目标
按模板填充内容，生成文档。

## 内容填充

### Python-docx 示例
```python
from docx import Document

doc = Document('template.docx')

# 替换文本
for paragraph in doc.paragraphs:
    for key, value in data.items():
        if f'{{{{{key}}}}}' in paragraph.text:
            paragraph.text = paragraph.text.replace(f'{{{{{key}}}}}', str(value))

# 保存文档
doc.save('output.docx')
```

### 表格填充
```python
# 填充表格
table = doc.tables[0]
for i, row_data in enumerate(data):
    row = table.rows[i + 1]  # 跳过表头
    for j, cell_data in enumerate(row_data):
        row.cells[j].text = str(cell_data)
```

### 图片插入
```python
from docx.shared import Inches

# 插入图片
doc.add_picture('image.png', width=Inches(4))
```

## 批量生成

```python
# 批量生成文档
for record in records:
    doc = Document('template.docx')
    fill_template(doc, record)
    doc.save(f'output_{record["id"]}.docx')
```

## 生成清单

- [ ] 内容是否完整
- [ ] 数据是否正确
- [ ] 是否有遗漏
