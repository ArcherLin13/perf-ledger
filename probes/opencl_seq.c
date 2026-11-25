/* Device-event sequential bandwidth. One kernel walks the buffer once.
   A sample sums many launches until about 150 ms of device time.
   Copy counts bytes read plus bytes written. No host gaps in the rate. */

#define CL_TARGET_OPENCL_VERSION 120
#include <CL/cl.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#endif

#define SAMPLES 11
#define WARMUP 3
#define TARGET_MS 150.0

static void blocked(const char* reason) {
  printf("{\"perfbind\":1,\"backend\":\"opencl\",\"blocked\":\"%s\",\"metrics\":[]}\n", reason);
  exit(2);
}

static void die(const char* what, cl_int err) {
  fprintf(stderr, "fail %s (%d)\n", what, err);
  exit(1);
}

static const char* kSource =
    "__kernel void k_read(__global const float4* in, __global volatile float* sink, int n4) {\n"
    "  int step = get_global_size(0);\n"
    "  float4 acc = (float4)(0.0f);\n"
    "  for (int i = get_global_id(0); i < n4; i += step) acc += in[i];\n"
    "  if (acc.x > 1.0e20f) sink[get_global_id(0)] = acc.x + acc.y + acc.z + acc.w;\n"
    "}\n"
    "__kernel void k_write(__global float4* out, int n4) {\n"
    "  int step = get_global_size(0);\n"
    "  for (int i = get_global_id(0); i < n4; i += step)\n"
    "    out[i] = (float4)((float)(i + 1) * 1.0e-7f);\n"
    "}\n"
    "__kernel void k_copy(__global const float4* in, __global float4* out, int n4) {\n"
    "  int step = get_global_size(0);\n"
    "  for (int i = get_global_id(0); i < n4; i += step) out[i] = in[i];\n"
    "}\n";

typedef enum { KIND_READ, KIND_WRITE, KIND_COPY } Kind;

static cl_device_id pick_device(void) {
  cl_uint nplat = 0;
  if (clGetPlatformIDs(0, NULL, &nplat) != CL_SUCCESS || nplat == 0) blocked("no_opencl_platform");
  cl_platform_id* plats = calloc(nplat, sizeof(cl_platform_id));
  clGetPlatformIDs(nplat, plats, NULL);
  cl_device_id chosen = NULL;
  for (cl_uint p = 0; p < nplat && !chosen; ++p) {
    cl_uint ndev = 0;
    if (clGetDeviceIDs(plats[p], CL_DEVICE_TYPE_GPU, 0, NULL, &ndev) != CL_SUCCESS || ndev == 0) continue;
    cl_device_id* devs = calloc(ndev, sizeof(cl_device_id));
    clGetDeviceIDs(plats[p], CL_DEVICE_TYPE_GPU, ndev, devs, NULL);
    chosen = devs[0];
    free(devs);
  }
  free(plats);
  if (!chosen) blocked("no_gpu_device");
  return chosen;
}

static char* device_string(cl_device_id dev, cl_device_info param) {
  size_t n = 0;
  clGetDeviceInfo(dev, param, 0, NULL, &n);
  char* s = calloc(n + 1, 1);
  clGetDeviceInfo(dev, param, n, s, NULL);
  return s;
}

static size_t global_size_for(int n4) {
  size_t threads = 65536;
  if ((size_t)n4 < threads) threads = (size_t)n4;
  threads -= threads % 256;
  if (threads < 256) threads = 256;
  return threads;
}

static double one_pass(cl_command_queue q, cl_kernel kernel, cl_mem a, cl_mem b, int n4, Kind kind) {
  cl_int err = 0;
  cl_event ev = NULL;
  clSetKernelArg(kernel, 0, sizeof(cl_mem), &a);
  if (kind == KIND_WRITE) clSetKernelArg(kernel, 1, sizeof(int), &n4);
  else {
    clSetKernelArg(kernel, 1, sizeof(cl_mem), &b);
    clSetKernelArg(kernel, 2, sizeof(int), &n4);
  }
  size_t global = global_size_for(n4);
  err = clEnqueueNDRangeKernel(q, kernel, 1, NULL, &global, NULL, 0, NULL, &ev);
  if (err != CL_SUCCESS) die("enqueue", err);
  err = clWaitForEvents(1, &ev);
  if (err != CL_SUCCESS) die("wait", err);
  cl_ulong t0 = 0, t1 = 0;
  clGetEventProfilingInfo(ev, CL_PROFILING_COMMAND_START, sizeof t0, &t0, NULL);
  clGetEventProfilingInfo(ev, CL_PROFILING_COMMAND_END, sizeof t1, &t1, NULL);
  clReleaseEvent(ev);
  return (double)(t1 - t0) / 1e6;
}

static void measure(const char* id, Kind kind, size_t bytes, cl_command_queue q, cl_kernel kernel, cl_mem a, cl_mem b, int first) {
  int n4 = (int)(bytes / 16);
  double one = one_pass(q, kernel, a, b, n4, kind);
  int passes = (int)(TARGET_MS / one + 0.5);
  if (passes < 1) passes = 1;
  if (passes > 20000) passes = 20000;
  fprintf(stderr, "probe %s one %.3f ms passes %d\n", id, one, passes);
  for (int i = 0; i < WARMUP; ++i) {
    for (int p = 0; p < passes; ++p) one_pass(q, kernel, a, b, n4, kind);
  }
  double moved = (double)passes * (double)bytes;
  if (kind == KIND_COPY) moved *= 2.0;
  if (!first) printf(",\n");
  printf("    {\"id\": \"%s\", \"kind\": \"%s\", \"unit\": \"GB/s\", \"bytes\": %zu, \"samples\": [", id, kind == KIND_READ ? "read" : kind == KIND_WRITE ? "write" : "copy", bytes);
  for (int i = 0; i < SAMPLES; ++i) {
    double ms = 0;
    for (int p = 0; p < passes; ++p) ms += one_pass(q, kernel, a, b, n4, kind);
    double gbps = moved / (ms * 1e6);
    printf("%s%.6f", i ? ", " : "", gbps);
  }
  printf("]}");
}

int main(void) {
#ifdef _WIN32
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
#endif
  cl_device_id dev = pick_device();
  char* name = device_string(dev, CL_DEVICE_NAME);
  cl_int err = 0;
  cl_context ctx = clCreateContext(NULL, 1, &dev, NULL, NULL, &err);
  if (err != CL_SUCCESS) die("context", err);
  cl_command_queue q = clCreateCommandQueue(ctx, dev, CL_QUEUE_PROFILING_ENABLE, &err);
  if (err != CL_SUCCESS) die("queue", err);
  size_t src_len = strlen(kSource);
  cl_program program = clCreateProgramWithSource(ctx, 1, &kSource, &src_len, &err);
  if (err != CL_SUCCESS) die("program", err);
  err = clBuildProgram(program, 1, &dev, "-cl-std=CL1.2", NULL, NULL);
  if (err != CL_SUCCESS) die("build", err);
  cl_kernel kread = clCreateKernel(program, "k_read", &err);
  cl_kernel kwrite = clCreateKernel(program, "k_write", &err);
  cl_kernel kcopy = clCreateKernel(program, "k_copy", &err);
  if (!kread || !kwrite || !kcopy) die("kernel", err);
  const size_t big = 128ull * 1024 * 1024;
  cl_mem in = clCreateBuffer(ctx, CL_MEM_READ_WRITE, big, NULL, &err);
  cl_mem out = clCreateBuffer(ctx, CL_MEM_READ_WRITE, big, NULL, &err);
  cl_mem sink = clCreateBuffer(ctx, CL_MEM_READ_WRITE, 65536 * sizeof(float), NULL, &err);
  if (!in || !out || !sink) die("buffer", err);
  float seed = 1.0f;
  clEnqueueFillBuffer(q, in, &seed, sizeof seed, 0, big, 0, NULL, NULL);
  clFinish(q);
  printf("{\n  \"perfbind\": 1,\n  \"backend\": \"opencl\",\n  \"probe_set\": \"opencl_sequential\",\n  \"device\": ");
  fputc('"', stdout);
  for (char* p = name; *p; ++p) {
    if (*p == '"' || *p == '\\') fputc('\\', stdout);
    fputc(*p, stdout);
  }
  printf("\",\n  \"metrics\": [\n");
  const size_t sizes[] = {8ull * 1024 * 1024, 128ull * 1024 * 1024};
  const char* labels[] = {"8192KiB", "131072KiB"};
  int first = 1;
  for (int s = 0; s < 2; ++s) {
    char id[64];
    snprintf(id, sizeof id, "read_%s", labels[s]);
    measure(id, KIND_READ, sizes[s], q, kread, in, sink, first);
    first = 0;
    printf(",\n");
    snprintf(id, sizeof id, "write_%s", labels[s]);
    measure(id, KIND_WRITE, sizes[s], q, kwrite, out, out, 1);
    printf(",\n");
    snprintf(id, sizeof id, "copy_%s", labels[s]);
    measure(id, KIND_COPY, sizes[s], q, kcopy, in, out, 1);
  }
  printf("\n  ]\n}\n");
  return 0;
}
