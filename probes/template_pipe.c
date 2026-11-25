/* Wall time of a synthetic shape instance, generated at runtime.
   Shapes: lut <entries> | arith <ops> | halo <radius> | launch <count>.
   A sample is the mean of repeated launches until at least 8 runs and 80 ms,
   matching the module_pipe protocol. Three warmup windows are discarded. */

#define CL_TARGET_OPENCL_VERSION 120
#include <CL/cl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#endif

static int WIDTH = 1920;
static int HEIGHT = 1080;
#define SAMPLES 11
#define WARMUP 3

static void blocked(const char* reason) {
  printf("{\"perfbind\":1,\"blocked\":\"%s\",\"metrics\":[]}\n", reason);
  exit(2);
}

static void die(const char* what, cl_int err) {
  fprintf(stderr, "fail %s (%d)\n", what, (int)err);
  exit(1);
}

static double now_ms(void) {
#ifdef _WIN32
  static LARGE_INTEGER freq;
  static int ready = 0;
  LARGE_INTEGER counter;
  if (!ready) {
    QueryPerformanceFrequency(&freq);
    ready = 1;
  }
  QueryPerformanceCounter(&counter);
  return (double)counter.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
  return 0;
#endif
}

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

static cl_program build_program(cl_context ctx, cl_device_id dev, const char* source) {
  cl_int err = 0;
  size_t len = strlen(source);
  cl_program program = clCreateProgramWithSource(ctx, 1, &source, &len, &err);
  if (err != CL_SUCCESS) die("program", err);
  err = clBuildProgram(program, 1, &dev, "-cl-std=CL1.2", NULL, NULL);
  if (err != CL_SUCCESS) {
    size_t log_n = 0;
    clGetProgramBuildInfo(program, dev, CL_PROGRAM_BUILD_LOG, 0, NULL, &log_n);
    char* log = calloc(log_n + 1, 1);
    clGetProgramBuildInfo(program, dev, CL_PROGRAM_BUILD_LOG, log_n, log, NULL);
    fprintf(stderr, "%s\n", log);
    die("build", err);
  }
  return program;
}

static cl_mem make_image(cl_context ctx, float* pixels, cl_mem_flags flags) {
  cl_image_format fmt = { CL_RGBA, CL_FLOAT };
  cl_image_desc desc;
  memset(&desc, 0, sizeof desc);
  desc.image_type = CL_MEM_OBJECT_IMAGE2D;
  desc.image_width = WIDTH;
  desc.image_height = HEIGHT;
  cl_int err = 0;
  cl_mem image = clCreateImage(ctx, flags | CL_MEM_COPY_HOST_PTR, &fmt, &desc, pixels, &err);
  if (err != CL_SUCCESS) die("image", err);
  return image;
}

static void append(char** buf, size_t* cap, size_t* len, const char* text) {
  size_t need = *len + strlen(text) + 1;
  if (need > *cap) {
    while (*cap < need) *cap *= 2;
    *buf = realloc(*buf, *cap);
  }
  memcpy(*buf + *len, text, strlen(text) + 1);
  *len += strlen(text);
}

/* Kernel source for a shape instance. n is baked in as a literal so the
   compiler sees the same structure the scanner would count. */
static char* gen_source(const char* shape, long n) {
  size_t cap = 4096, len = 0;
  char* buf = calloc(cap, 1);
  char line[512];
  append(&buf, &cap, &len,
         "const sampler_t sampleri = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_NEAREST;\n");
  if (strcmp(shape, "lut") == 0) {
    append(&buf, &cap, &len,
           "__kernel void templ(read_only image2d_t in, write_only image2d_t out, const int width, const int height,\n"
           "                    __global const float* table) {\n"
           "  const int x = get_global_id(0);\n"
           "  const int y = get_global_id(1);\n"
           "  if (x >= width || y >= height) return;\n"
           "  float4 p = read_imagef(in, sampleri, (int2)(x, y));\n");
    snprintf(line, sizeof line, "  p.x += table[(unsigned)(x + y * width) %% %ld];\n", n);
    append(&buf, &cap, &len, line);
    append(&buf, &cap, &len, "  write_imagef(out, (int2)(x, y), p);\n}\n");
    return buf;
  }
  if (strcmp(shape, "arith") == 0) {
    static const char* ops[6] = { "sin", "cos", "tan", "exp", "log", "sqrt" };
    append(&buf, &cap, &len,
           "__kernel void templ(read_only image2d_t in, write_only image2d_t out, const int width, const int height) {\n"
           "  const int x = get_global_id(0);\n"
           "  const int y = get_global_id(1);\n"
           "  if (x >= width || y >= height) return;\n"
           "  float4 p = read_imagef(in, sampleri, (int2)(x, y));\n"
           "  float v = p.x + 0.25f;\n");
    for (long i = 0; i < n; i++) {
      const char* op = ops[i % 6];
      if (strcmp(op, "log") == 0 || strcmp(op, "sqrt") == 0)
        snprintf(line, sizeof line, "  v = %s(fabs(v) + 0.001f);\n", op);
      else
        snprintf(line, sizeof line, "  v = %s(v);\n", op);
      append(&buf, &cap, &len, line);
    }
    append(&buf, &cap, &len, "  p.x += v;\n  write_imagef(out, (int2)(x, y), p);\n}\n");
    return buf;
  }
  if (strcmp(shape, "halo") == 0) {
    append(&buf, &cap, &len,
           "__kernel void templ(read_only image2d_t in, write_only image2d_t out, const int width, const int height) {\n"
           "  const int x = get_global_id(0);\n"
           "  const int y = get_global_id(1);\n"
           "  if (x >= width || y >= height) return;\n"
           "  float sum = 0.f;\n");
    snprintf(line, sizeof line,
             "  for (int i = -%ld; i <= %ld; ++i) sum += read_imagef(in, sampleri, (int2)(clamp(x + i, 0, width - 1), y)).x;\n",
             n, n);
    append(&buf, &cap, &len, line);
    snprintf(line, sizeof line, "  float4 p = (float4)(sum / %ld.f, 0.f, 0.f, 1.f);\n", 2 * n + 1);
    append(&buf, &cap, &len, line);
    append(&buf, &cap, &len, "  write_imagef(out, (int2)(x, y), p);\n}\n");
    return buf;
  }
  if (strcmp(shape, "launch") == 0) {
    append(&buf, &cap, &len,
           "__kernel void templ(read_only image2d_t in, write_only image2d_t out, const int width, const int height) {\n"
           "  const int x = get_global_id(0);\n"
           "  const int y = get_global_id(1);\n"
           "  if (x >= width || y >= height) return;\n"
           "  float4 p = read_imagef(in, sampleri, (int2)(x, y));\n"
           "  p.x += 1.f;\n"
           "  write_imagef(out, (int2)(x, y), p);\n}\n");
    return buf;
  }
  free(buf);
  blocked("unknown_shape");
  return NULL;
}

typedef struct {
  cl_command_queue q;
  cl_kernel kernel;
  size_t global[2];
  long launches;
} Job;

static double once(void* ctx) {
  Job* job = ctx;
  cl_int err = CL_SUCCESS;
  double t0 = now_ms();
  for (long i = 0; i < job->launches; i++) {
    err = clEnqueueNDRangeKernel(job->q, job->kernel, 2, NULL, job->global, NULL, 0, NULL, NULL);
    if (err != CL_SUCCESS) die("enqueue", err);
  }
  err = clFinish(job->q);
  double ms = now_ms() - t0;
  if (err != CL_SUCCESS) die("finish", err);
  return ms;
}

static double window_mean(Job* job) {
  int n = 0;
  double sum = 0;
  while (n < 8 || sum < 80.0) {
    sum += once(job);
    n += 1;
    if (n >= 40) break;
  }
  return sum / (double)n;
}

int main(int argc, char** argv) {
  if (argc < 3) blocked("usage: template_pipe <shape> <n> [width] [height]");
  const char* shape = argv[1];
  long n = atol(argv[2]);
  if (n < 1 || n > 100000) blocked("bad_param");
  if (argc >= 5) {
    WIDTH = atoi(argv[3]);
    HEIGHT = atoi(argv[4]);
    if (WIDTH <= 0 || HEIGHT <= 0) blocked("bad size");
  }
  if (strcmp(shape, "lut") && strcmp(shape, "arith") && strcmp(shape, "halo") && strcmp(shape, "launch"))
    blocked("unknown_shape");
#ifdef _WIN32
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
#endif
  cl_device_id dev = pick_device();
  cl_int err = 0;
  cl_context ctx = clCreateContext(NULL, 1, &dev, NULL, NULL, &err);
  if (err != CL_SUCCESS) die("context", err);
  cl_command_queue q = clCreateCommandQueue(ctx, dev, 0, &err);
  if (err != CL_SUCCESS) die("queue", err);

  size_t pixels = (size_t)WIDTH * HEIGHT * 4;
  float* host = calloc(pixels, sizeof(float));
  for (size_t i = 0; i < pixels; i += 4) {
    host[i] = (float)((i / 4) % WIDTH) / (float)WIDTH;
    host[i + 1] = (float)((i / 4) / WIDTH) / (float)HEIGHT;
    host[i + 2] = 0.18f;
    host[i + 3] = 1.f;
  }

  char* source = gen_source(shape, n);
  cl_program program = build_program(ctx, dev, source);
  cl_kernel kernel = clCreateKernel(program, "templ", &err);
  if (err != CL_SUCCESS) die("kernel", err);

  Job job;
  memset(&job, 0, sizeof job);
  job.q = q;
  job.kernel = kernel;
  job.global[0] = WIDTH;
  job.global[1] = HEIGHT;
  job.launches = strcmp(shape, "launch") == 0 ? n : 1;

  cl_mem in_img = make_image(ctx, host, CL_MEM_READ_ONLY);
  cl_mem out_img = make_image(ctx, host, CL_MEM_WRITE_ONLY);
  clSetKernelArg(kernel, 0, sizeof(cl_mem), &in_img);
  clSetKernelArg(kernel, 1, sizeof(cl_mem), &out_img);
  clSetKernelArg(kernel, 2, sizeof(int), &WIDTH);
  clSetKernelArg(kernel, 3, sizeof(int), &HEIGHT);

  cl_mem table = NULL;
  if (strcmp(shape, "lut") == 0) {
    float* values = malloc(sizeof(float) * (size_t)n);
    for (long i = 0; i < n; i++) values[i] = 0.001f * (float)(i % 7);
    table = clCreateBuffer(ctx, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, sizeof(float) * (size_t)n, values, &err);
    if (err != CL_SUCCESS) die("table", err);
    clSetKernelArg(kernel, 4, sizeof(cl_mem), &table);
  }

  double samples[SAMPLES];
  for (int i = 0; i < WARMUP; i++) (void)window_mean(&job);
  for (int i = 0; i < SAMPLES; i++) samples[i] = window_mean(&job);

  printf("{\"id\":\"%s_%ld_%dx%d\",\"shape\":\"%s\",\"param\":%ld,\"kernels\":%ld,\"halo\":%ld,\"width\":%d,\"height\":%d,\"unit\":\"ms\",\"samples\":[",
         shape, n, WIDTH, HEIGHT, shape, n,
         strcmp(shape, "launch") == 0 ? n : 1,
         strcmp(shape, "halo") == 0 ? n : 0,
         WIDTH, HEIGHT);
  for (int i = 0; i < SAMPLES; ++i) printf("%s%.6f", i ? "," : "", samples[i]);
  printf("]}\n");
  return 0;
}
