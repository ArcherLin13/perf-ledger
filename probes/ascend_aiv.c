/* Ascend vector unit. This is an elementwise add, not a memcpy and not a cube op.
   Bytes touched are two reads plus one write. If aclnn_add.h is missing or the
   signatures in this CANN do not match, the probe does not compile and no rate is stored.
   A failed device open prints blocked and no rate. */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "acl/acl.h"
#include "aclnnop/aclnn_add.h"

#define SAMPLES 11
#define WARMUP 3

static void blocked(const char* reason) {
  printf("{\"perfbind\":1,\"backend\":\"ascend_aiv\",\"blocked\":\"%s\",\"metrics\":[]}\n", reason);
  exit(2);
}

static void check(aclError err, const char* what) {
  if (err != ACL_SUCCESS) {
    fprintf(stderr, "fail %s (%d)\n", what, (int)err);
    blocked("runtime_failed");
  }
}

static aclTensor* vector_tensor(void* dev, int64_t n) {
  int64_t dims[] = {n};
  int64_t strides[] = {1};
  return aclCreateTensor(dims, 1, ACL_FLOAT, strides, 0, ACL_FORMAT_ND, dims, 1, dev);
}

static float one_add_ms(aclTensor* x, aclTensor* y, aclTensor* z, aclScalar* alpha, aclrtStream stream, aclrtEvent start, aclrtEvent end) {
  uint64_t workspace_size = 0;
  aclOpExecutor* executor = NULL;
  if (aclnnAddGetWorkspaceSize(x, y, alpha, z, &workspace_size, &executor) != ACL_SUCCESS) blocked("aclnn_add_unavailable");
  void* workspace = NULL;
  if (workspace_size > 0) check(aclrtMalloc(&workspace, workspace_size, ACL_MEM_MALLOC_HUGE_FIRST), "workspace");
  check(aclrtRecordEvent(start, stream), "record");
  if (aclnnAdd(workspace, workspace_size, executor, stream) != ACL_SUCCESS) blocked("aclnn_add_unavailable");
  check(aclrtRecordEvent(end, stream), "record");
  check(aclrtSynchronizeEvent(end), "sync");
  float ms = 0.f;
  check(aclrtEventElapsedTime(&ms, start, end), "elapsed");
  if (workspace) aclrtFree(workspace);
  return ms;
}

int main(void) {
#ifdef _WIN32
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
#endif
  if (aclInit(NULL) != ACL_SUCCESS) blocked("acl_init_failed");
  if (aclrtSetDevice(0) != ACL_SUCCESS) blocked("no_device");
  const size_t sizes[] = {8ull * 1024 * 1024, 128ull * 1024 * 1024};
  const char* labels[] = {"8192KiB", "131072KiB"};
  void* dx = NULL;
  void* dy = NULL;
  void* dz = NULL;
  check(aclrtMalloc(&dx, sizes[1], ACL_MEM_MALLOC_HUGE_FIRST), "malloc");
  check(aclrtMalloc(&dy, sizes[1], ACL_MEM_MALLOC_HUGE_FIRST), "malloc");
  check(aclrtMalloc(&dz, sizes[1], ACL_MEM_MALLOC_HUGE_FIRST), "malloc");
  float one = 1.f;
  aclScalar* alpha = aclCreateScalar(&one, ACL_FLOAT);
  if (!alpha) blocked("tensor_create_failed");
  aclrtStream stream = NULL;
  aclrtEvent start, end;
  check(aclrtCreateStream(&stream), "stream");
  check(aclrtCreateEvent(&start), "event");
  check(aclrtCreateEvent(&end), "event");
  printf("{\n  \"perfbind\": 1,\n  \"backend\": \"ascend_aiv\",\n  \"probe_set\": \"ascend_aiv_add\",\n  \"metrics\": [\n");
  for (int s = 0; s < 2; ++s) {
    const int64_t n = (int64_t)(sizes[s] / sizeof(float));
    aclTensor* x = vector_tensor(dx, n);
    aclTensor* y = vector_tensor(dy, n);
    aclTensor* z = vector_tensor(dz, n);
    if (!x || !y || !z) blocked("tensor_create_failed");
    for (int i = 0; i < WARMUP; ++i) one_add_ms(x, y, z, alpha, stream, start, end);
    const double touched = (double)sizes[s] * 3.0;
    if (s) printf(",\n");
    printf("    {\"id\": \"aiv_add_%s\", \"kind\": \"elementwise\", \"unit\": \"GB/s\", \"bytes\": %zu, \"samples\": [", labels[s], sizes[s]);
    for (int i = 0; i < SAMPLES; ++i) {
      int reps = 0;
      float ms = 0.f;
      while (ms < 150.f && reps < 100000) {
        ms += one_add_ms(x, y, z, alpha, stream, start, end);
        reps += 1;
      }
      double gbps = (touched * (double)reps) / ((double)ms * 1e6);
      printf("%s%.6f", i ? ", " : "", gbps);
    }
    printf("]}");
  }
  printf("\n  ]\n}\n");
  aclFinalize();
  return 0;
}
