# Run deploy this way:
./deploy.sh \
  --stack image-processing-stack \
  --region us-west-2 \
  --arch x86_64 \
  --target images.juniorbay.net \
  --base image-processor-source \
  --profile default \
  --clean \
  --auto-recover-rollback