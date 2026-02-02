/**
 * CBB 聚合支付服务 Java 客户端模板
 *
 * 使用方法:
 *   1. 添加依赖: httpclient, jackson-databind, commons-codec
 *   2. 配置 CLIENT_ID, CLIENT_SECRET, CUSTOMER_CODE 等参数
 *   3. 实例化 CBBPayClient 并调用相应方法
 *
 * 示例:
 *   CBBPayClient client = new CBBPayClient.Builder()
 *       .clientId("your_client_id")
 *       .clientSecret("your_client_secret")
 *       .customerCode("your_customer_code")
 *       .build();
 *
 *   Map<String, Object> result = client.createTrade(
 *       "测试商品", "0.01", "test_order_001", "2025-12-31T23:59:59Z", null);
 */

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.http.client.methods.*;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.*;
import org.apache.http.util.EntityUtils;

import java.security.*;
import java.security.spec.*;
import java.util.*;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class CBBPayClient {
    private final String clientId;
    private final String clientSecret;
    private final String customerCode;
    private final String gatewayUrl;
    private final String privateKey;
    private final String publicKey;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final CloseableHttpClient httpClient = HttpClients.createDefault();

    private String accessToken;
    private long tokenExpiresAt;

    private CBBPayClient(Builder builder) {
        this.clientId = builder.clientId;
        this.clientSecret = builder.clientSecret;
        this.customerCode = builder.customerCode;
        this.gatewayUrl = builder.gatewayUrl.replaceAll("/$", "");
        this.privateKey = builder.privateKey;
        this.publicKey = builder.publicKey;
    }

    // ==================== 认证方法 ====================

    /**
     * 获取访问令牌
     */
    public synchronized String getAccessToken(boolean forceRefresh) throws Exception {
        if (!forceRefresh && accessToken != null && System.currentTimeMillis() < tokenExpiresAt) {
            return accessToken;
        }
        String url = gatewayUrl + "/auth/v2/security/oauth/token";
        HttpPost post = new HttpPost(url);
        post.setHeader("Content-Type", "application/x-www-form-urlencoded");

        String body = String.format("grant_type=client_credentials&client_id=%s&client_secret=%s",
                URLEncoder.encode(clientId, "UTF-8"),
                URLEncoder.encode(clientSecret, "UTF-8"));
        post.setEntity(new StringEntity(body));

        try (CloseableHttpResponse response = httpClient.execute(post)) {
            String json = EntityUtils.toString(response.getEntity());
            Map<String, Object> result = objectMapper.readValue(json, Map.class);
            accessToken = (String) result.get("access_token");
            int expiresIn = (Integer) result.getOrDefault("expires_in", 7200);
            tokenExpiresAt = System.currentTimeMillis() + expiresIn * 1000L - 300000L;
            return accessToken;
        }
    }

    // ==================== 内部方法 ====================

    private Map<String, String> getHeaders() throws Exception {
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + getAccessToken(false));
        headers.put("x-cbb-client-customer", customerCode);
        headers.put("x-cbb-client-type", "api");
        headers.put("Content-Type", "application/json");
        return headers;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> callApi(String method, String path, Map<String, Object> data) throws Exception {
        String url = gatewayUrl + path;
        HttpRequestBase request;
        if ("POST".equals(method)) {
            HttpPost post = new HttpPost(url);
            if (data != null) {
                post.setEntity(new StringEntity(objectMapper.writeValueAsString(data), "UTF-8"));
            }
            request = post;
        } else {
            request = new HttpGet(url);
        }
        for (Map.Entry<String, String> h : getHeaders().entrySet()) {
            request.setHeader(h.getKey(), h.getValue());
        }
        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int status = response.getStatusLine().getStatusCode();
            String json = EntityUtils.toString(response.getEntity());
            if (status == 401) {
                getAccessToken(true);
                return callApi(method, path, data);
            }
            return objectMapper.readValue(json, Map.class);
        }
    }

    // ==================== 订单接口 ====================

    /** 创建订单 */
    public Map<String, Object> createTrade(String goodName, String amount, String outTradeNo,
            String expireTime, String businessParams) throws Exception {
        Map<String, Object> data = new HashMap<>();
        data.put("goodName", goodName);
        data.put("totalNumber", amount);
        data.put("outTradeNo", outTradeNo);
        data.put("expireTime", expireTime);
        if (businessParams != null) data.put("businessParams", businessParams);
        return callApi("POST", "/api/v2/pay/trade", data);
    }

    /** 查询订单 */
    public Map<String, Object> queryTrade(String tradeNo, boolean includeThirdPayData) throws Exception {
        String path = "/api/v2/pay/trade/" + tradeNo;
        if (includeThirdPayData) path += "?includeThirdPayData=true";
        return callApi("GET", path, null);
    }

    /** 根据业务订单号查询 */
    public Map<String, Object> queryTradeByOutTradeNo(String outTradeNo, String createDate) throws Exception {
        Map<String, Object> data = new HashMap<>();
        data.put("outTradeNo", outTradeNo);
        data.put("createDate", createDate);
        return callApi("POST", "/api/v2/pay/trade/outTradeNo", data);
    }

    // ==================== 退款接口 ====================

    /** 申请退款 */
    public Map<String, Object> applyRefund(String tradeNo, String refundAmount,
            String outRequestNo, String refundReason) throws Exception {
        Map<String, Object> data = new HashMap<>();
        data.put("tradeNo", tradeNo);
        data.put("refundAmount", refundAmount);
        data.put("outRequestNo", outRequestNo);
        data.put("refundReason", refundReason);
        return callApi("POST", "/api/v2/pay/refund/apply", data);
    }

    /** 查询退款结果 */
    public Map<String, Object> queryRefund(String tradeNo, String outRequestNo) throws Exception {
        return callApi("GET", "/api/v2/pay/refund/query/" + tradeNo + "/" + outRequestNo, null);
    }

    // ==================== 支付辅助接口 ====================

    /** 获取支付二维码 */
    public Map<String, Object> getQrCode(String tradeNo, String payThird) throws Exception {
        return callApi("GET", "/api/v2/pay/trade/qrCode/" + payThird + "/" + tradeNo, null);
    }

    /** 获取支付渠道列表 */
    public Map<String, Object> getChannel(String environment) throws Exception {
        return callApi("GET", "/api/v2/pay/trade/channel/" + environment, null);
    }

    /** 获取微信小程序支付参数 */
    public Map<String, Object> getWxMiniProgramParam(String tradeNo, String openId) throws Exception {
        return callApi("GET", "/api/v2/pay/trade/getWxMiniProgramParam/" + tradeNo + "/" + openId, null);
    }

    // ==================== 页面服务 ====================

    /** 构建PC端支付页面URL */
    public String buildPcPayUrl(String tradeNo, String turnUrl) throws Exception {
        if (privateKey == null) throw new IllegalStateException("需要配置 privateKey 才能使用页面服务");
        Map<String, String> params = new TreeMap<>();
        params.put("client_id", clientId);
        params.put("tradeNo", tradeNo);
        params.put("nonceStr", UUID.randomUUID().toString().replace("-", ""));
        params.put("timeStamp", String.valueOf(System.currentTimeMillis()));
        params.put("charset", "utf-8");
        if (turnUrl != null) params.put("turnUrl", turnUrl);
        return buildPageUrl("/page/v2/pay/trade/pc/toPay", params);
    }

    /** 构建移动端H5支付页面URL */
    public String buildWapPayUrl(String tradeNo, String turnUrl, String quitUrl) throws Exception {
        if (privateKey == null) throw new IllegalStateException("需要配置 privateKey 才能使用页面服务");
        Map<String, String> params = new TreeMap<>();
        params.put("client_id", clientId);
        params.put("tradeNo", tradeNo);
        params.put("nonceStr", UUID.randomUUID().toString().replace("-", ""));
        params.put("timeStamp", String.valueOf(System.currentTimeMillis()));
        params.put("charset", "utf-8");
        if (turnUrl != null) params.put("turnUrl", turnUrl);
        if (quitUrl != null) params.put("quitUrl", quitUrl);
        return buildPageUrl("/page/v2/pay/trade/wap/toPay", params);
    }

    private String buildPageUrl(String path, Map<String, String> params) throws Exception {
        String sign = signParams(params);
        StringBuilder sb = new StringBuilder(gatewayUrl).append(path).append("?");
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (e.getKey() != null && e.getValue() != null) {
                String encoded = URLEncoder.encode(URLEncoder.encode(e.getValue(), "UTF-8"), "UTF-8");
                sb.append(e.getKey()).append("=").append(encoded).append("&");
            }
        }
        sb.append("sign=").append(URLEncoder.encode(URLEncoder.encode(sign, "UTF-8"), "UTF-8"));
        return sb.toString();
    }

    private String signParams(Map<String, String> params) throws Exception {
        StringBuilder content = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (e.getKey() != null && e.getValue() != null) {
                if (content.length() > 0) content.append("&");
                content.append(e.getKey()).append("=").append(e.getValue());
            }
        }
        byte[] keyBytes = Base64.getDecoder().decode(privateKey);
        PKCS8EncodedKeySpec spec = new PKCS8EncodedKeySpec(keyBytes);
        PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(spec);
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initSign(key);
        signature.update(content.toString().getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(signature.sign());
    }

    // ==================== 回调验签 ====================

    /** 验证回调签名 */
    public boolean verifyCallback(Map<String, String> params) throws Exception {
        if (publicKey == null) throw new IllegalStateException("需要配置 publicKey 才能验证回调签名");
        Map<String, String> paramsCopy = new TreeMap<>(params);
        String sign = paramsCopy.remove("sign");
        if (sign == null) return false;

        StringBuilder content = new StringBuilder();
        for (Map.Entry<String, String> e : paramsCopy.entrySet()) {
            if (e.getKey() != null && e.getValue() != null) {
                if (content.length() > 0) content.append("&");
                content.append(e.getKey()).append("=").append(e.getValue());
            }
        }
        byte[] keyBytes = Base64.getDecoder().decode(publicKey);
        X509EncodedKeySpec spec = new X509EncodedKeySpec(keyBytes);
        PublicKey key = KeyFactory.getInstance("RSA").generatePublic(spec);
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initVerify(key);
        signature.update(content.toString().getBytes(StandardCharsets.UTF_8));
        return signature.verify(Base64.getDecoder().decode(sign));
    }

    // Builder 类定义
    public static class Builder {
        private String clientId;
        private String clientSecret;
        private String customerCode;
        private String gatewayUrl = "https://api.webtrn.cn";
        private String privateKey;
        private String publicKey;

        public Builder clientId(String clientId) { this.clientId = clientId; return this; }
        public Builder clientSecret(String clientSecret) { this.clientSecret = clientSecret; return this; }
        public Builder customerCode(String customerCode) { this.customerCode = customerCode; return this; }
        public Builder gatewayUrl(String gatewayUrl) { this.gatewayUrl = gatewayUrl; return this; }
        public Builder privateKey(String privateKey) { this.privateKey = privateKey; return this; }
        public Builder publicKey(String publicKey) { this.publicKey = publicKey; return this; }
        public CBBPayClient build() { return new CBBPayClient(this); }
    }
}
