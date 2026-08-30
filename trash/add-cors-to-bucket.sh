BUCKET=image-processor-source-150544707159-image-processing-stack

cat > cors.json <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "https://images.juniorbay.net"
      ],
      "AllowedMethods": ["POST", "PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 86400
    }
  ]
}
JSON

aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file://cors.json
