package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// AuthResult 鉴权结果
type AuthResult struct {
	OK          bool
	Reason      string
	ProductType string
	Usertag     string // iCubeAuthInfo://usertag 的值，用于埋点上报
}

// getStoragePath 返回 Trae storage.json 路径（跨平台，与 src/auth.ts 保持一致）
func getStoragePath() string {
	var base string
	switch runtime.GOOS {
	case "darwin":
		base = filepath.Join(os.Getenv("HOME"), "Library", "Application Support")
	case "windows":
		base = os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
		}
	default: // linux
		base = os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(os.Getenv("HOME"), ".config")
		}
	}
	return filepath.Join(base, "Trae CN", "User", "globalStorage", "storage.json")
}

// findProductType 递归查找对象中的 productType 字段
// 对应 src/auth.ts 中的 findProductType 方法
func findProductType(obj interface{}) string {
	switch v := obj.(type) {
	case map[string]interface{}:
		// productType 可能为字符串或数字（如企业版订阅返回 231），统一转为字符串
		if pt, ok := v["productType"]; ok {
			switch ptVal := pt.(type) {
			case string:
				return ptVal
			case float64:
				return fmt.Sprintf("%v", ptVal)
			}
		}
		for _, val := range v {
			if result := findProductType(val); result != "" {
				return result
			}
		}
	case []interface{}:
		for _, item := range v {
			if result := findProductType(item); result != "" {
				return result
			}
		}
	}
	return ""
}

// readUsertag 读取 iCubeAuthInfo://usertag 字段值作为用户标识
func readUsertag(storageData map[string]interface{}) string {
	raw, ok := storageData["iCubeAuthInfo://usertag"]
	if !ok || raw == nil {
		return ""
	}
	switch v := raw.(type) {
	case string:
		return v
	default:
		// 非 string 类型尝试 JSON 序列化
		bytes, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(bytes)
	}
}

// VerifyStorage 读取 Trae 本地 storage.json 校验企业版订阅状态
// 逻辑与 src/auth.ts 中的 Auth.verify() 完全一致
func VerifyStorage() AuthResult {
	storagePath := getStoragePath()

	// 1. 文件存在性检查
	if _, err := os.Stat(storagePath); os.IsNotExist(err) {
		return AuthResult{
			OK:     false,
			Reason: fmt.Sprintf("未检测到 Trae 登录信息（%s 不存在），请先登录 Trae 企业版账号", storagePath),
		}
	}

	// 2. 读取文件
	raw, err := os.ReadFile(storagePath)
	if err != nil {
		return AuthResult{
			OK:     false,
			Reason: fmt.Sprintf("读取 storage.json 失败: %s", err.Error()),
		}
	}

	// 3. JSON 解析
	var storageData map[string]interface{}
	if err := json.Unmarshal(raw, &storageData); err != nil {
		return AuthResult{
			OK:     false,
			Reason: fmt.Sprintf("storage.json 解析失败: %s", err.Error()),
		}
	}

	// 4. 获取 iCubeServerData://icube.cloudide 字段
	serverDataRaw, ok := storageData["iCubeServerData://icube.cloudide"]
	if !ok || serverDataRaw == nil {
		return AuthResult{
			OK:     false,
			Reason: "未检测到 Trae 企业版订阅信息，请先登录 Trae 企业版账号",
		}
	}

	// 5. serverDataRaw 是 JSON 字符串，需要二次解析
	var serverData interface{}
	switch v := serverDataRaw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &serverData); err != nil {
			return AuthResult{
				OK:     false,
				Reason: fmt.Sprintf("iCubeServerData 解析失败: %s", err.Error()),
			}
		}
	default:
		serverData = v
	}

	// 6. 递归查找 productType 字段
	productType := findProductType(serverData)
	if productType == "" {
		return AuthResult{
			OK:     false,
			Reason: "当前账号未购买 Trae 企业版，无法使用知识库助手插件",
		}
	}

	// 7. 鉴权通过，读取 usertag
	return AuthResult{
		OK:          true,
		ProductType: productType,
		Usertag:     readUsertag(storageData),
	}
}
