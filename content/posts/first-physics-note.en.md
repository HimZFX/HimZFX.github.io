---
title: "Metric Tensor in GR"
date: 2025-12-05
draft: false  # <--- 重要！一定要把 true 改成 false，否则发布时看不见
---

这是我的第一篇测试文章。我们将讨论 Schwarzschild 度规。

## 场方程
爱因斯坦场方程可以写为：

$$R_{\mu\nu} - \frac{1}{2}R g_{\mu\nu} = \frac{8\pi G}{c^4} T_{\mu\nu}$$

在真空解中 ($T_{\mu\nu}=0$)，我们可以推导出行星进动。

## 代码测试
我也在研究如何用 Python 分析数据：

```python
import numpy as np

def calculate_event_horizon(mass):
    G = 6.67430e-11
    c = 2.998e8
    return 2 * G * mass / c**2

print("Hello Black Hole")