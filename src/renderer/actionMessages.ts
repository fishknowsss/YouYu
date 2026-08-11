export function isActionErrorMessage(message: string): boolean {
  return /失败|超时|错误|不可用|未加载|未获|先|没有|不对|太频繁|请重新登记/.test(message);
}
